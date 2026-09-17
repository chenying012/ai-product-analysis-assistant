# 多用户化改造：现状盘点与集成设计

**文档状态**：设计草案，待评审后实施
**日期**：2026-09-17
**当前代码基线**：`main` = `e6dc4b4`（78 个测试通过，Node 22.12 / 24.14 双版本验证）

---

## 0. 这次改造的性质

必须先说清楚：**这不是加三个功能，而是改变应用的性质。**

| 维度 | 现在 | 改造后 |
| --- | --- | --- |
| 状态 | 完全无状态，请求之间无关联 | 有状态，需要持久化存储 |
| 用户 | 无账户概念，单一共享口令 | 多用户，独立数据与凭据 |
| 数据 | 不落盘，用完即弃 | 长期保存分析历史与积分流水 |
| 依赖 | 无数据库 | 必须引入数据库 |
| 失败影响 | 单次请求失败 | 可能造成数据不一致（如积分扣了但分析失败） |
| 合规面 | 无个人数据 | 存储凭据与行为记录，涉及个人数据保护 |

现有 README 里"**不包含**：数据库、用户账户、历史记录、追价任务"这句话，改造完成后需要一并改写。

**因此本文档的目的是先把风险和取舍讲清楚，而不是直接开工。** 下面每一节都标注了「必须由你决策」的点。

---

## 1. 现有功能完整盘点

### 1.1 已实现的能力

**输入校验**

- Amazon 站点白名单 20 个区域站（`lib/amazon-url.ts`）
- 只接受 `/dp/ASIN`、`/gp/product/ASIN` 商品详情路径，拒绝搜索页、店铺页、短链
- URL 长度上限 2048 字符，请求体上限 4KB

**商品信息采集与解析（不经过 AI）**

- `lib/server/source.ts`：Node `https` 直连抓取，或走 Firecrawl `/v2/scrape`
  - 自定义 DNS `lookup`，用 `ipaddr.js` 校验解析出的每个 IP，阻断非公网地址（SSRF 防护）
  - 逐跳校验重定向，有跳数上限
  - 页面大小上限 4MB，超时 30 秒
  - 支持 gzip / deflate / brotli 解压
- `lib/server/product-parser.ts`：Cheerio 静态解析，**不执行页面脚本**
  - 提取名称、品牌、品类、价格、功能要点、规格表、主图、JSON-LD
  - 价格选择器**只在本商品购买区容器内**取值，避免误取推荐位其他商品的价格
  - 识别多型号商品的当前型号与可选型号总数（`dimensionValuesDisplayData`）
  - 判定价格缺失的真实原因：`region_restricted` / `out_of_stock` / `not_found`
  - 标注非美元本地化报价（`priceLocalised`）
  - 解析内嵌 JSON 用手写括号配对扫描，不用 `eval`
- 身份校验：页面 ASIN 与链接不符则报 `PRODUCT_MISMATCH`，材料不足报 `INSUFFICIENT_PRODUCT_DATA`

**AI 分析与口播生成**

- `lib/server/generate.ts`：OpenAI 兼容 Chat Completions
  - 输入**只有**带编号的证据列表（`F1..Fn`，图片证据 `V1..Vn`），不是原始 HTML
  - 输出目标人群、使用场景、用户痛点、核心卖点、口播（hook + body）
  - Zod 契约校验 + 结构校验：证据编号必须存在、必须中文、hook ≤ 20 字、全文 ≤ 150 字
  - `MAX_ATTEMPTS = 3`（首次 + 最多 2 次修正），保留首个结构合法草稿避免修正后丢结果
  - 对 `api.deepseek.com` 精确主机名发送 `thinking.type=disabled`，不向其他供应商发送该私有参数
- `lib/server/vision.ts`：可选图片分析，仅 5 个 Amazon 官方图床域名、`jpeg`/`png`/`webp`、4MB 上限，失败返回 `null` 不阻塞主流程

**内容质量检查（`lib/server/quality.ts`）**

10 条确定性规则：

| 规则码 | 级别 |
| --- | --- |
| `absolute_claim`、`guaranteed_effect`、`health_claim`、`unsupported_number`、`unsupported_comparison`、`price_claim`、`dropped_condition` | 阻断 |
| `purchase_pressure`、`hook_too_slow`、`weak_citation` | 提示 |

阻断级问题把**具体短语**回传模型要求改写；仍未修好则如实返回 `passed: false` 与完整问题列表，不擅自改写、不假装通过。

**流程编排（`lib/server/analyze-handler.ts`）**

- 共享访问口令校验（`APP_ACCESS_TOKEN`，`timingSafeEqual` 比较哈希）
- 单进程并发上限 2、每分钟 10 次（`RequestGate`，内存计数）
- 总超时 90 秒，模型单次 35 秒，抓取 30 秒，图片 30 秒
- NDJSON 流式推送：`stage` → `product` → `result`，**商品档案先推送**，模型失败时已抓到的信息仍可查看
- 34 个错误码，每个带 `retryable` 标记

**前端（`components/product-assistant.tsx`）**

单页交互：链接输入、口令输入、进度显示、商品档案、四类分析、口播卡片与复制、质量报告、错误提示、取消按钮。

### 1.2 现有安全措施

- 密钥只从服务端环境变量读取，不进前端、不进响应、不进日志
- `/api/status` 只返回布尔状态
- SSRF 防护（见上）
- 提示注入防护：模型只拿结构化证据，无联网与工具调用权限
- 响应头：`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options: DENY`
- `.env.local` 与运行产物已被 `.gitignore` 排除，仓库全历史无密钥

### 1.3 现有测试

78 个用例，全部离线：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/core.test.ts` | 27 | URL 校验、页面解析、字段缺失、型号识别、价格原因 |
| `tests/advanced.test.ts` | 24 | 质量规则、时长估算、图片降级 |
| `tests/pipeline.test.ts` | 27 | 模型协议、自动修正、取消、事件流、访问口令 |

### 1.4 当前部署

| 项 | 值 |
| --- | --- |
| 演示地址 | `68acf3344a2b42fcb72391236349cf4c.ap-singapore.myide.io` |
| 出网地区 | 新加坡 |
| 进程管理 | `setsid nohup npx next start`，**无自动重启，已多次自行停止** |
| 数据持久化 | 无 |

### 1.5 已知限制（改造需要继承的现实）

- **价格覆盖约 1/3**：12 个抽测商品中 4 个取到价格，5 个因地区不可配送而页面根本不下发价格，2 个缺货，1 个 ASIN 失效
- 抓取成功率受反爬影响，可能偶发返回人机验证页
- 视觉模型真实识别质量未验证（DeepSeek 不支持图片输入）
- 质量检查是规则性的，不做语义级事实核查

---

## 2. 需求一：数据加密解密与 HTTPS 传输安全

### 2.1 现状实测结果

我刚实测了当前部署地址：

```
HTTPS → HTTP 200   （TLS 可用，平台已提供证书）
HTTP  → HTTP 200   （明文同样可访问，未跳转）
HSTS  → 无
```

**结论有两面**：

- 好消息：**HTTPS 本来就能用**，平台在边缘层提供了证书。不需要我们自己签发或管理证书。
- 问题：**明文 HTTP 也照样能访问，且没有 HSTS**。用户如果输入 `http://` 或被中间人降级，凭据和 Cookie 会走明文。

所以这一项的真实工作**不是"实现 HTTPS"，而是"强制 HTTPS 并封住明文入口"**。

### 2.2 设计方案

**A. 强制 HTTPS（中间件层）**

新增 `middleware.ts`：

- 读 `x-forwarded-proto`，若为 `http` 则 308 跳转到 `https://`
- 响应头加 `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- 补充 `Content-Security-Policy`、`X-Frame-Options`（现有）
- 本地开发（`localhost`）豁免，否则无法调试

> ⚠️ **必须由你决策**：HSTS 一旦被浏览器记住，该域名在有效期内**无法再用 http 访问**。如果这个沙箱域名将来要复用做别的用途，需要先想清楚。建议初期 `max-age` 设短（如 300 秒）验证无误后再调长。

**B. 传输层之外，哪些数据需要加密存储**

这里要**区分三种不同的处理方式**，不能一律"加密"：

| 数据 | 处理方式 | 理由 |
| --- | --- | --- |
| 用户密码 | **哈希，不是加密**（Argon2id 或 scrypt） | 密码永不需要还原。用可解密的方式存储是设计错误 |
| 会话令牌 | 存 SHA-256 哈希 | 同上，服务端只需验证不需还原 |
| 用户自带的模型 API Key（如果做这个功能） | **AES-256-GCM 加密** | 调用时必须还原成明文，所以只能加密 |
| 商品分析结果、口播文案 | **不加密** | 内容来自公开商品页，不是敏感数据 |
| 操作历史、积分流水 | **不加密** | 同上，靠访问控制隔离而非加密 |
| 用户邮箱 | 不加密，但需要唯一索引 | 登录要用它查询 |

**过度加密是有害的**：加密字段无法建索引、无法排序、无法做条件查询，还会让备份恢复和问题排查变得困难。**该用访问控制解决的问题不要用加密解决。**

**C. 算法选择与理由**

| 用途 | 算法 | 理由 |
| --- | --- | --- |
| 密码哈希 | **scrypt**（Node 内置 `crypto.scrypt`） | 内存硬，抗 GPU 破解。**选它而不是 Argon2 是因为 Node 内置，不引入原生依赖** —— 这对 Serverless 部署很重要 |
| 对称加密 | **AES-256-GCM**（Node 内置） | 认证加密，同时保证机密性与完整性，能检测篡改 |
| 令牌哈希 | SHA-256 | 令牌本身是高熵随机值，不需要慢哈希 |
| 随机数 | `crypto.randomBytes` | 密码学安全随机源 |
| 常数时间比较 | `crypto.timingSafeEqual` | 防时序侧信道，现有代码已在用 |

**全部使用 Node 内置 `node:crypto`，不新增加密依赖。** 理由：加密库是高风险依赖，供应链攻击影响面大；Node 内置实现由核心团队维护，且无需编译原生模块。

**D. 密钥管理**

```
DATA_ENCRYPTION_KEY   32 字节，base64 编码，用于 AES-256-GCM
SESSION_SECRET        32 字节，用于会话令牌签名
```

管理规则：

- 只从环境变量读取，**绝不进代码、仓库、日志**
- 启动时校验长度，不合格直接拒绝启动（fail fast，而不是退化成弱加密）
- 每条加密记录**独立随机 IV**（12 字节），存储格式 `v1:<iv-base64>:<ciphertext-base64>:<tag-base64>`
- 格式带版本前缀 `v1`，为将来轮换密钥留出兼容路径

> ⚠️ **必须由你决策**：密钥轮换方案。最简单的做法是「只支持单一当前密钥，轮换时全量重加密」，实现简单但轮换期间要停写。更完善的是「保留旧密钥用于解密、新密钥用于加密」。**我的建议是先做前者**，因为现在数据量为零，将来真要轮换时全量重加密的成本也极低。

### 2.3 这一项的诚实边界

- **应用层无法防御平台层的中间人**。TLS 在平台边缘终止，平台内部到我们进程之间是明文 HTTP。这是所有 PaaS 的共同特征，不是我们能解决的。
- HSTS 只对**访问过一次 HTTPS 的浏览器**有效，首次访问仍可能被降级（需要 HSTS Preload 才能解决，但那需要提交到浏览器厂商列表，沙箱域名不适合）。
- 我不会声称"实现了端到端加密"。这个应用没有端到端加密，服务端能看到全部明文。

---

## 3. 需求二：用户管理系统

### 3.1 数据模型

```sql
-- 用户
CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- ULID，避免暴露注册顺序
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- scrypt: N$r$p$salt$hash
  credits       INTEGER NOT NULL DEFAULT 0, -- 见第 4 节
  status        TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 会话（存哈希，不存原文）
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,              -- SHA-256(令牌原文)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,                          -- 截断保存，用于用户识别可疑登录
  ip_prefix  TEXT                           -- 只存网段前缀，不存完整 IP
);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (expires_at);       -- 便于清理过期会话

-- 操作历史
CREATE TABLE activity_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,                -- register | login | logout | analyze | ...
  target      TEXT,                         -- 分析类操作存 ASIN
  outcome     TEXT NOT NULL,                -- success | failed
  error_code  TEXT,                         -- 失败时记录错误码
  credits_delta INTEGER NOT NULL DEFAULT 0,
  detail      JSONB,                        -- 结构化补充信息
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON activity_logs (user_id, created_at DESC);

-- 分析结果（用户隔离的业务数据）
CREATE TABLE analyses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asin        TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  product     JSONB NOT NULL,               -- Product 契约
  content     JSONB,                        -- Content 契约，失败时为 NULL
  quality     JSONB,                        -- Quality 契约
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON analyses (user_id, created_at DESC);
```

### 3.2 数据隔离机制

**核心原则：隔离在数据访问层强制，不依赖调用方自觉传 `user_id`。**

这是最容易出错的地方。常见错误写法：

```ts
// 危险：忘记加 user_id 条件就是越权漏洞
db.query("SELECT * FROM analyses WHERE id = $1", [id]);
```

设计上的防护：

1. **所有用户数据表的查询函数强制第一个参数是 `userId`**，类型层面无法省略
2. 单条查询一律带 `AND user_id = $userId`，即使已知 `id`
3. 更新与删除同样带 `user_id` 条件，**通过返回的影响行数判断是否越权**，而不是先查后改
4. 补充针对性测试：**用 A 用户的会话去访问 B 用户的资源 ID，必须返回 404 而不是 403** —— 返回 403 会泄露"该资源存在"这一信息

> 我不打算用 Postgres 的 Row Level Security。虽然它更彻底，但会把授权逻辑分散到数据库策略里，与应用层的错误处理和测试割裂，排查成本高。**在应用层集中控制 + 针对性越权测试**对这个规模的项目更合适。

### 3.3 认证方式

| 决策项 | 选择 | 理由 |
| --- | --- | --- |
| 会话机制 | **服务端会话表 + httpOnly Cookie** | 而不是 JWT。JWT 无法即时吊销，改密码或封禁用户后旧令牌仍有效。会话表可以立即删除 |
| Cookie 属性 | `HttpOnly` + `Secure` + `SameSite=Lax` | `HttpOnly` 防 XSS 窃取；`SameSite=Lax` 防 CSRF 同时不影响正常导航 |
| 令牌 | 32 字节随机，只存哈希 | 数据库泄露时无法直接用于登录 |
| 有效期 | 7 天，滑动续期 | — |
| 登录限速 | 按邮箱 + IP 前缀计数 | 防撞库 |

**注册与登录都必须做的**：

- 邮箱格式校验、密码强度下限（长度 ≥ 10）
- **登录失败时统一错误信息**（"邮箱或密码不正确"），不区分"用户不存在"与"密码错误"，否则可被用于枚举已注册邮箱
- 密码错误时也执行一次哈希计算，避免通过响应时间差异枚举用户

### 3.4 与现有 `APP_ACCESS_TOKEN` 的关系

> ⚠️ **必须由你决策**：现在有了用户系统，共享口令怎么办？

三个选项：

| 选项 | 说明 | 影响 |
| --- | --- | --- |
| **A. 移除** | 完全由用户系统接管 | 简洁，但演示时面试官必须注册 |
| **B. 保留为"演示模式"** | 有口令可免注册试用，但不记录历史、不扣积分 | 演示友好，但两套授权路径并存，测试面翻倍 |
| **C. 保留为管理员总开关** | 口令正确才允许注册 | 防止公开注册被滥用消耗你的模型额度 |

**我的建议是 C。** 理由：你的模型 Key 是真实付费资源，公开注册意味着任何人都能注册领 10 积分消耗你的额度。C 能挡住这个风险，改动也最小。

### 3.5 操作历史的隐私考量

- **不记录完整 IP**，只存网段前缀（如 `203.0.113.0/24`），够用于识别异常登录，又不构成精确定位
- 不记录 User-Agent 全文，截断到 200 字符
- 历史记录只能查自己的，且**保留期上限**（建议 90 天，超期清理）
- 用户注销账户时 `ON DELETE CASCADE` 连带删除，符合"被遗忘权"的基本要求

---

## 4. 需求三：积分管理

### 4.1 数据模型

`users.credits` 存当前余额（见 3.1），另加流水表：

```sql
CREATE TABLE credit_transactions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,             -- 正数增加，负数扣减
  balance_after INTEGER NOT NULL,           -- 冗余存快照，便于对账
  reason      TEXT NOT NULL,                -- signup_bonus | api_call | refund | admin_adjust
  ref_id      TEXT,                         -- 关联的 analyses.id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON credit_transactions (user_id, created_at DESC);

-- 幂等保护：同一次分析不会被重复扣费
CREATE UNIQUE INDEX ON credit_transactions (user_id, reason, ref_id)
  WHERE ref_id IS NOT NULL;
```

**为什么余额与流水都要存**：只存流水则每次要 `SUM` 聚合，随记录增长变慢；只存余额则无法追溯和对账。两者都存，用流水校验余额。

### 4.2 关键难点：扣费时机

这是本次改造**最容易出错的地方**，需要专门说明。

现有 `/api/analyze` 是**流式响应**：先推送商品档案，再推送分析结果。整个过程 10–90 秒，且**中途可能失败**：抓取被反爬拦截、模型超时、质量检查未通过、用户主动取消。

如果简单地"进来就扣 1 分"：

- 抓取失败（`SOURCE_BLOCKED`）→ 用户什么都没得到却被扣分 → 会被合理投诉
- 用户取消 → 同上

如果"成功后再扣"：

- 用户可以并发发起大量请求，在扣费发生前全部通过校验 → **积分绕过**

**设计方案：预扣 + 失败退回**

```
1. 事务内：校验余额 ≥ 1 → 扣 1 分 → 写流水(reason=api_call, ref_id=分析ID)
2. 执行分析流程（抓取 → 模型 → 质量检查）
3a. 成功 → 写入 analyses，记录 activity_log(success)
3b. 失败 → 事务内退回 1 分 → 写流水(reason=refund, ref_id=同一分析ID)
          → 记录 activity_log(failed, error_code)
```

关键细节：

- **步骤 1 必须在流式响应开始之前完成。** 一旦开始推流就无法再返回 401/402 状态码
- 扣费与流水写入必须在**同一个数据库事务**里，避免余额和流水不一致
- 余额校验用 `UPDATE users SET credits = credits - 1 WHERE id = $1 AND credits >= 1`，靠**影响行数**判断是否成功，而不是"先查再改"（后者有竞态）
- 退款用唯一索引保证幂等，防止重试导致多次退款

> ⚠️ **必须由你决策**：哪些失败该退款？
>
> 我的建议：
> - **退款**：抓取失败、模型超时、模型报错、用户取消、内部错误 —— 这些用户没有获得价值
> - **不退款**：分析成功但质量检查 `passed: false` —— 已经消耗了真实模型 token，且结果仍然可用（附带问题列表）
>
> 后者可以讨论，但我倾向不退，否则用户可以反复触发质量失败来白用。

### 4.3 注册赠送

```
注册事务内：创建 users(credits=0) → UPDATE credits += 10
          → 写流水(delta=+10, reason=signup_bonus)
          → 写 activity_log(register)
```

必须在**同一事务**，否则可能出现"用户创建成功但没送积分"。

> ⚠️ **必须由你决策**：10 分够用吗？按每次分析 1 分，注册后只能用 10 次。演示场景够，但如果面试官想多试几个商品就不够了。是否需要一个"管理员补分"的入口？

### 4.4 积分不足的处理

- HTTP **402 Payment Required**，错误码 `INSUFFICIENT_CREDITS`
- 响应体给出当前余额，前端明确提示"积分不足，当前余额 0"
- **在流式响应开始前返回**，不占用模型调用
- 前端在余额 ≤ 3 时提前显示提醒，避免用户输入完链接才被拒

### 4.5 与现有限流的关系

现有 `RequestGate` 是**单进程内存计数**，在多实例部署下失效（README 已注明）。

积分系统实际上提供了一层**跨实例的真实配额**——因为它落在数据库里。但两者目的不同：

- 限流防的是**瞬时并发压垮进程**（保护服务）
- 积分防的是**总量滥用**（保护成本）

**两者都要保留。** 建议把 `RequestGate` 的计数从"全局"改成"按 `user_id`"，这样一个用户的突发请求不会挤占其他用户的额度。

---

## 5. 技术选型

### 5.1 数据库：这是本次最关键的决策

**部署环境的硬约束**：

| 环境 | 文件系统 | 实例数 | SQLite 可行性 |
| --- | --- | --- | --- |
| Vercel | 只读（`/tmp` 除外且不共享） | 多实例 | **完全不可行** |
| CloudStudio 沙箱 | 可写 | 单实例 | 可行但**会随环境重启丢数据**（已多次发生） |

> 我实测过这个沙箱**反复自行停止服务**。把用户账户和积分放在它的本地文件里，等于随时可能丢光所有用户数据。

**因此必须用外部托管数据库。** 候选：

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **Neon**（Serverless Postgres） | 免费额度够用，HTTP 驱动适配 Serverless，冷启动快 | 需注册第三方账号 |
| **Supabase** | 免费额度 + 自带认证模块 | 认证模块与我们自建的会话机制重叠，容易两套并存 |
| Vercel Postgres | 与 Vercel 集成最省事 | 绑定 Vercel |

**我的建议：Neon + 原生 SQL**。

理由：

- 免费额度足够演示规模
- 用 `@neondatabase/serverless` 的 HTTP 驱动，**不需要长连接池**，这对 Serverless 和会重启的沙箱都友好
- **不引入 ORM**。当前项目零 ORM、用 Zod 做契约校验，风格一致。ORM 会带来 schema 定义、迁移工具链、生成代码等一大堆概念，对 5 张表的规模是过度设计
- 原生 SQL 让"每个查询都带 `user_id`"这件事**在代码里肉眼可见**，比 ORM 的隐式作用域更容易审计

> ⚠️ **必须由你决策**：是否接受注册一个 Neon 账号？如果不接受，替代方案是继续用沙箱 + SQLite，但**必须接受数据可能丢失**，那样就只能当作功能演示而非可靠服务。

### 5.2 依赖增量

| 新增 | 用途 | 是否必需 |
| --- | --- | --- |
| `@neondatabase/serverless` | Postgres HTTP 驱动 | 必需（若选 Neon） |
| — | 加密：用 Node 内置 `node:crypto` | 不新增 |
| — | 会话：自己实现 | 不新增 |
| — | 迁移：手写 SQL 文件 + 一个执行脚本 | 不新增 |

**只增加 1 个依赖。** 现有 7 个生产依赖的精简风格得以保持。

### 5.3 新增文件结构

```
middleware.ts                      HTTPS 强制跳转 + HSTS

lib/
  crypto.ts                        scrypt 密码哈希、AES-256-GCM、常数时间比较
  auth-contracts.ts                注册/登录/历史查询的 Zod 契约
  server/
    db.ts                          连接与事务封装
    users.ts                       注册、登录、按 ID 查询
    sessions.ts                    创建、校验、吊销、清理过期
    credits.ts                     扣减、退回、赠送、查流水（全部带 user_id）
    activity.ts                    操作历史写入与查询
    analyses.ts                    分析结果存取（全部带 user_id）
    auth-context.ts                从请求 Cookie 解析出当前用户

app/api/
  auth/register/route.ts
  auth/login/route.ts
  auth/logout/route.ts
  me/route.ts                      当前用户 + 余额
  history/route.ts                 操作历史（分页）
  analyses/route.ts                分析历史列表
  analyses/[id]/route.ts           单条详情（带 user_id 校验）

migrations/
  001_init.sql                      建表
  run.ts                           迁移执行脚本

components/
  auth-panel.tsx                   注册/登录表单
  credit-badge.tsx                 余额显示
  history-panel.tsx                操作历史与分析历史

tests/
  crypto.test.ts                   加密解密、篡改检测、哈希验证
  auth.test.ts                     注册、登录、会话、枚举防护
  credits.test.ts                  扣减、退款、幂等、余额不足、并发
  isolation.test.ts                跨用户越权访问（重点）
```

### 5.4 对现有代码的改动

**尽量小，且不破坏现有 78 个测试。**

| 文件 | 改动 |
| --- | --- |
| `lib/server/analyze-handler.ts` | 依赖注入新增 `auth`、`credits`、`activity`、`analyses`；在推流前完成鉴权与预扣；`RequestGate` 改为按用户计数 |
| `lib/errors.ts` | 新增 `UNAUTHENTICATED`(401)、`INSUFFICIENT_CREDITS`(402)、`ACCOUNT_DISABLED`(403)、`EMAIL_TAKEN`(409) |
| `lib/contracts.ts` | `SetupStatus` 增加 `authEnabled`、`databaseConfigured` |
| `next.config.ts` | 补 CSP（HSTS 放在 middleware） |
| `components/product-assistant.tsx` | 增加登录态、余额显示、历史入口 |

现有 `Dependencies` 注入模式（`analyze-handler.ts` 第 25–41 行的 `type Dependencies` 与 `defaults`）**正好适合这次扩展**——新增的数据库操作都通过依赖注入传入，测试时替换成内存实现，**现有测试不需要连数据库**。这是当前架构给我们的便利。

---

## 6. 实施计划

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| 1 | `lib/crypto.ts` + 单元测试 | 加解密往返正确、篡改被检出、错误密钥失败 |
| 2 | 数据库连接 + 迁移脚本 | 迁移可重复执行、表结构正确 |
| 3 | 用户与会话 + 测试 | 注册登录可用、枚举防护生效、会话可吊销 |
| 4 | 积分 + 测试 | 赠送、扣减、退款、幂等、并发不超扣 |
| 5 | 数据隔离 + **越权测试** | A 用户无法访问 B 用户任何资源 |
| 6 | 接入 `analyze-handler` | 现有 78 个测试仍全部通过 |
| 7 | `middleware.ts` HTTPS 强制 | http 被 308 跳转、HSTS 头存在 |
| 8 | 前端登录与历史 | 完整流程可用 |
| 9 | 部署与外部验证 | 真实环境跑通注册→分析→扣分→查历史 |

**每个阶段结束都跑全量测试**，不允许"最后一起调"。

---

## 7. 风险清单

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| **积分与分析结果不一致** | 扣了分没结果，或有结果没扣分 | 预扣 + 失败退回 + 幂等索引 |
| **越权访问** | 用户看到别人数据，严重事故 | 所有查询强制带 `user_id` + 专项越权测试 |
| **沙箱数据丢失** | 用户账户与积分全丢 | 用外部托管数据库，不用本地文件 |
| **公开注册被滥用** | 你的模型额度被陌生人消耗 | 建议保留 `APP_ACCESS_TOKEN` 作为注册开关（见 3.4） |
| 密钥丢失 | 加密数据无法解密 | 启动时校验；文档提示备份 |
| HSTS 误配 | 域名在有效期内无法用 http | 先设短 `max-age` 验证 |
| 流式响应中的事务处理 | 连接被长时间占用 | 扣费事务在推流前提交，不跨流式过程持有连接 |
| 现有测试被破坏 | 回归风险 | 依赖注入 + 内存实现，现有测试不连数据库 |

---

## 8. 需要你确认的决策点

在开工前请回复这几项，避免做完再改：

1. **数据库**：是否接受注册 Neon（免费）？若不接受，是否接受沙箱 SQLite 的数据丢失风险？
2. **`APP_ACCESS_TOKEN`**：移除 / 演示模式 / 注册开关（我建议注册开关）？
3. **质量检查未通过是否退积分**（我建议不退）？
4. **注册赠送 10 分是否够**？是否需要管理员补分入口？
5. **HSTS `max-age`**：先用短值（300 秒）验证，还是直接一年？
6. **范围确认**：是否需要「用户自带模型 Key」功能？这是唯一真正需要 AES 加密存储的场景。如果不需要，加密模块的实际用途会小很多——**我需要知道你是否希望它成为一个被真实使用的功能，而不是为了满足需求清单而存在的摆设。**

---

## 9. 文档同步

改造完成后需要更新：

- `README.md`：删除"不包含数据库、用户账户、历史记录"，新增用户系统与积分章节，环境变量表补 4 个新变量
- 测试数量（当前 78，预计增加 30–40）
- 架构数据流图（增加鉴权与扣费环节）
