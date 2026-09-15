"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ArrowUpRight, AudioLines, Box, Check, ChevronRight, CircleHelp, Copy, FileText, Layers3, Link2, LoaderCircle, Package, Settings2, ShieldCheck, Sparkles, Target, Users, X, AlertCircle, RefreshCw, Lightbulb, BadgeCheck, ShieldAlert, Timer, Image as ImageIcon } from "lucide-react";
import { characterCount, scriptText, type AnalysisPoint, type Content, type Product, type PublicError, type Quality, type SetupStatus } from "@/lib/contracts";
import { normalizeAmazonUrl } from "@/lib/amazon-url";
import { consumeAnalysisStream } from "@/lib/event-stream";
import { publicError } from "@/lib/errors";

type Stage = "idle" | "fetching" | "inspecting" | "analyzing" | "reviewing" | "done";
const stageCopy: Record<string, { title: string; detail: string }> = {
  fetching: { title: "正在获取商品的真实信息", detail: "识别名称、功能与规格，不用标题猜测商品详情。" },
  inspecting: { title: "正在识别商品主图", detail: "只记录图片中可见的外观特征，作为独立编号的依据。" },
  analyzing: { title: "正在分析用户价值，构思中文口播", detail: "基于本次页面信息生成，完成后检查结构、引用与文案字数。" },
  reviewing: { title: "正在做内容质量检查", detail: "核对夸大表述、无依据数字与口播时长，必要时要求模型修正。" },
};
const examples = [
  { label: "题目示例 01", url: "https://www.amazon.com/dp/B0F6YQ96L5" },
  { label: "题目示例 02", url: "https://www.amazon.com/dp/B0CXT9RSGQ" },
];

export default function ProductAssistant({ initialSetup }: { initialSetup: SetupStatus }) {
  const [setup, setSetup] = useState(initialSetup);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState<Product | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [error, setError] = useState<PublicError | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configFeedback, setConfigFeedback] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const ready = setup.modelConfigured && setup.sourceConfigured;

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (settingsOpen) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [settingsOpen]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setProduct(null);
    setContent(null);
    setQuality(null);
    try { normalizeAmazonUrl(url); } catch (issue) { setError(publicError(issue)); return; }
    if (!ready) {
      setError({ code: "MODEL_NOT_CONFIGURED", message: "先完成服务端接口配置，就可以开始真实分析。我们不会用预设结果替代模型输出。", retryable: false });
      setSettingsOpen(true);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setStage("fetching");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(token ? { "x-app-access-token": token } : {}) },
        body: JSON.stringify({ url }),
      });
      await consumeAnalysisStream(response, (message) => {
        if (message.type === "stage") setStage(message.stage);
        if (message.type === "product") setProduct(message.product);
        if (message.type === "result") { setContent(message.content); setQuality(message.quality); setStage("done"); }
        if (message.type === "error") { setContent(null); setQuality(null); setError(message.error); setStage("idle"); }
      });
    } catch (issue) {
      setContent(null);
      setQuality(null);
      setStage("idle");
      setError(controller.signal.aborted
        ? { code: "CANCELLED", message: "已取消分析。可以修改链接后重新开始，已获取的商品信息保留在下方。", retryable: true }
        : publicError(issue));
    } finally { setBusy(false); abortRef.current = null; }
  }

  async function refreshConfig() {
    setConfigFeedback("正在读取配置状态…");
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const status: SetupStatus = await response.json();
      setSetup(status);
      setConfigFeedback(status.modelConfigured && status.sourceConfigured ? "配置已填写，可以关闭此窗口开始分析。接口连通性将在请求时验证。" : "还未检测到完整配置。保存 .env.local 后请重启服务，再刷新。" );
    } catch { setConfigFeedback("读取配置状态失败，请检查本地服务是否运行。"); }
  }

  return <>
    <header className="site-header">
      <div className="header-inner">
        <a className="brand" href="/" aria-label="品析首页"><span className="brand-icon"><Box size={21} strokeWidth={1.7} /></span><span>品析<span className="brand-en">PRODUCT LENS</span></span></a>
        <nav aria-label="主导航"><span className="nav-current">产品工作台</span><button className="text-button" onClick={() => setSettingsOpen(true)}>使用说明 <ArrowUpRight size={14} /></button></nav>
        <button className={`connection-status ${ready ? "configured" : ""}`} onClick={() => setSettingsOpen(true)}><span className="status-dot" />{ready ? "接口已配置" : "待配置接口"}<Settings2 size={13} /></button>
      </div>
    </header>

    <main className="main-shell">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="eyebrow"><span className="tiny-star"><Sparkles size={13} /></span> YOUR PRODUCT, A CLEARER PERSPECTIVE</div>
          <h1 id="hero-title">看懂一个产品，<br />讲好<span className="accent-word">它的价值<span /></span>。</h1>
          <p className="hero-description">从一个 Amazon 商品链接开始。整理关键信息，<br className="desktop-break" />理解用户需求，把产品特点变成自然、有吸引力的中文口播。</p>
        </div>
        <div className="hero-note" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="hero-cube"><Box size={43} strokeWidth={1.1} /></div><span className="floating-label label-one"><FileText size={13} /> 商品信息</span><span className="floating-label label-two"><Lightbulb size={13} /> 用户价值</span><span className="floating-label label-three"><AudioLines size={13} /> 内容表达</span><span className="orbit-dot" /></div>
      </section>

      <section className="input-panel" aria-labelledby="input-heading">
        <div className="panel-topline"><h2 id="input-heading"><span className="step-number">01</span> 从商品链接开始</h2><span className="amazon-badge">amazon<span className="amazon-smile" /></span></div>
        <form onSubmit={submit}>
          <div className="url-row"><label className="url-field"><Link2 size={19} /><span className="sr-only">Amazon 商品链接</span><input type="url" required maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} placeholder="粘贴 Amazon 商品详情页链接，发现产品的更多可能" autoComplete="off" spellCheck={false} /></label><button className="primary-button" type="submit" disabled={busy || !url.trim()}>{busy ? <><LoaderCircle size={17} className="spin" /> 分析中</> : <>开始分析 <ArrowRight size={18} /></>}</button></div>
          {setup.accessProtected && <label className="access-field">网站访问口令<input type="password" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} autoComplete="off" placeholder="向网站维护者获取，仅本次页面使用" required /></label>}
          <div className="input-meta"><div className="examples"><span>没有链接？试试</span>{examples.map((example) => <button key={example.label} type="button" disabled={busy} onClick={() => { setUrl(example.url); setError(null); }}>{example.label}<ArrowUpRight size={11} /></button>)}</div><span className="source-caption"><ShieldCheck size={13} />公开商品页面 · 缺失信息明确标注</span></div>
        </form>
        {!ready && <div className="setup-notice"><span className="notice-icon"><Settings2 size={17} /></span><div><strong>还差一步：连接你的接口</strong><p>网页已就绪。配置模型与可用商品来源后，即可运行真实分析。</p></div><button onClick={() => setSettingsOpen(true)}>查看配置 <ChevronRight size={15} /></button></div>}
      </section>

      {error && <div className="error-panel" role="alert"><AlertCircle size={19} /><div><strong>{error.code === "CANCELLED" ? "分析已取消" : "这次分析还没有完成"}</strong><p>{error.message}</p>{error.code.startsWith("MODEL_") || error.code.startsWith("SOURCE_") ? <button className="inline-link" onClick={() => setSettingsOpen(true)}>检查接口配置 <ArrowUpRight size={12} /></button> : null}</div><button className="icon-button" aria-label="关闭提示" onClick={() => setError(null)}><X size={16} /></button></div>}

      {busy && <div className="progress-panel" role="status" aria-live="polite"><div className="progress-spinner"><LoaderCircle size={22} className="spin" /></div><div><strong>{(stageCopy[stage] ?? stageCopy.analyzing).title}</strong><p>{(stageCopy[stage] ?? stageCopy.analyzing).detail}</p></div><button className="text-button" onClick={() => abortRef.current?.abort()}>取消</button></div>}

      {product ? <section className="results" aria-labelledby="result-heading"><div className="section-heading"><div><span className="section-kicker">PRODUCT WORKSPACE</span><h2 id="result-heading">你的产品，逐层看清。</h2></div><span className="result-state"><span className={`status-dot ${content ? (quality && !quality.passed ? "amber" : "green") : ""}`} />{content ? (quality && !quality.passed ? "已生成 · 有待修正提示" : "分析已生成") : "商品信息已获取"}</span></div><ProductDetails key={`${product.url}-${product.source.fetchedAt}`} product={product} />{content ? <><div className="analysis-section"><div className="subsection-heading"><h3><Target size={18} /> 产品分析</h3><span className="inference-label">基于页面信息的 AI 推断</span></div><div className="analysis-grid"><InsightGroup title="目标人群" icon={<Users size={18} />} points={content.audiences} /><InsightGroup title="使用场景" icon={<Layers3 size={18} />} points={content.scenarios} /><InsightGroup title="用户痛点" icon={<Target size={18} />} points={content.painPoints} /><InsightGroup title="核心卖点" icon={<Lightbulb size={18} />} points={content.sellingPoints} /></div></div><ScriptCard content={content} quality={quality} />{quality && <QualityPanel quality={quality} />}<p className="result-disclaimer"><CircleHelp size={14} /> AI 分析与文案供创作参考，不代表实测结论。发布前请核对商品事实，并按实际语速确认口播时长。</p></> : !busy && <div className="partial-result"><AudioLines size={22} /><span>商品档案已保留。解决上方提示后重新分析，即可继续生成产品洞察与口播。</span></div>}</section> : <EmptyState />}

      <footer className="page-footer"><span>PRODUCT LENS<span className="footer-separator">/</span>从信息，到理解，再到表达。</span><span>基础版 <span className="footer-dot">·</span> 为真实产品而写</span></footer>
    </main>

    <dialog className="settings-dialog" ref={dialogRef} onClose={() => setSettingsOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }} aria-labelledby="settings-title">
      <div className="dialog-content"><div className="dialog-heading"><div><span className="section-kicker">GET CONNECTED</span><h2 id="settings-title">连接你的工作环境</h2></div><button className="icon-button" aria-label="关闭配置说明" onClick={() => setSettingsOpen(false)}><X size={21} /></button></div><p className="dialog-intro">密钥只在服务端保存，不需要填写到网页或聊天里。<br />在项目根目录将 <code>.env.example</code> 复制为 <code>.env.local</code>。</p>
        <div className="config-step"><span>1</span><div><h3>配置兼容 OpenAI 的模型接口 <ConfigBadge done={setup.modelConfigured} /></h3><p>填写 <code>OPENAI_API_KEY</code>、<code>OPENAI_BASE_URL</code> 和 <code>OPENAI_MODEL</code>。模型需支持 Chat Completions 与 JSON object 输出。</p></div></div>
        <div className="config-step"><span>2</span><div><h3>选择商品信息来源 <span className="config-label">{setup.source === "direct" ? "当前：直连" : "当前：Firecrawl"}</span></h3><p><code>PRODUCT_SOURCE=direct</code> 无需采集 Key，但可能遇到 Amazon 访问限制。已有 Firecrawl 账户时，可改为 <code>firecrawl</code> 并填写 <code>FIRECRAWL_API_KEY</code>。使用前请确认费用及访问条件。</p></div></div>
        <div className="config-step"><span>3</span><div><h3>重启服务，再开始分析</h3><p>配置生效后，用公开商品链接检查真实结果。没有接口、访问受限或材料不足时，工具会明确报错，不显示假数据。</p></div></div>
        <div className="config-security"><ShieldCheck size={17} /><p>公开分享前建议配置 <code>APP_ACCESS_TOKEN</code> 保护接口。访问口令不是模型密钥，请勿混用。</p></div>
        <div className="dialog-bottom"><span role="status">{configFeedback || "配置状态只表示字段已填写，不代表接口已验证可用。"}</span><button className="secondary-button" onClick={refreshConfig}><RefreshCw size={14} />刷新状态</button></div>
      </div>
    </dialog>
  </>;
}

function ConfigBadge({ done }: { done: boolean }) {
  return <span className={`config-label ${done ? "is-done" : ""}`}>{done ? "已填写" : "待配置"}</span>;
}

function EmptyState() {
  const cards = [
    { title: "信息，不再零散", number: "01", subtitle: "产品信息整理", description: "名称、价格、核心功能与规格。把页面里的关键信息，整理成一份清晰的产品档案。", icon: <FileText size={22} />, tags: ["产品名称", "核心功能", "规格参数"], className: "facts-preview" },
    { title: "特点，变成价值", number: "02", subtitle: "用户与场景分析", description: "谁会需要它，在哪使用，解决什么问题。从产品特点出发，理解真正的用户价值。", icon: <Target size={22} />, tags: ["目标人群", "使用场景", "核心卖点"], className: "insight-preview" },
    { title: "让内容，自然发生", number: "03", subtitle: "中文短视频口播", description: "用一个具体场景吸引注意，再讲清产品收益。150 字以内，让文案更适合开口说。", icon: <AudioLines size={22} />, tags: ["开头钩子", "自然表达", "≤ 150 字"], className: "script-preview" },
  ];
  return <section className="empty-section" aria-labelledby="empty-heading"><div className="section-heading"><div><span className="section-kicker">ONE LINK. THREE PERSPECTIVES.</span><h2 id="empty-heading">一个链接，三个清晰视角。</h2></div><p>少一点整理，多一点好内容。</p></div><div className="feature-grid">{cards.map((card) => <article className="feature-card" key={card.number}><div className={`feature-visual ${card.className}`}><div className="visual-icon">{card.icon}</div><div className="visual-lines"><i /><i /><i /></div><div className="visual-tags">{card.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><span className="visual-index">{card.number}</span></div><div className="feature-text"><span className="feature-subtitle">{card.subtitle}</span><h3>{card.title}</h3><p>{card.description}</p></div></article>)}</div><div className="quiet-note"><ShieldCheck size={15} /><span>页面事实与 AI 推断分开展示。无法获取的信息，不用猜测补齐。</span></div></section>;
}

function ProductDetails({ product }: { product: Product }) {
  const [imageFailed, setImageFailed] = useState(false);
  return <article className="product-card"><div className="product-main"><div className="product-image">{product.imageUrl && !imageFailed ? <img src={product.imageUrl} alt={product.title} onError={() => setImageFailed(true)} referrerPolicy="no-referrer" /> : <div className="image-fallback"><Package size={42} strokeWidth={1.1} /><span>商品图片暂未取得</span></div>}</div><div className="product-info"><div className="product-overline"><span>产品档案</span><span>{product.marketplace}</span></div><h3>{product.title}</h3><div className="product-tags"><span>ASIN · {product.asin}</span>{product.brand && <span>{product.brand}</span>}{product.variant?.name && <span>型号 · {product.variant.name}</span>}{product.variant && !product.variant.name && <span>{product.variant.total} 个型号可选</span>}</div><div className="price-row"><span className="price">{product.price?.display || (product.priceUnavailableReason === "region_restricted" ? "价格未展示（本地区不可配送）" : product.priceUnavailableReason === "out_of_stock" ? "价格未展示（页面显示缺货）" : "价格未取得")}</span><span>页面展示价 · 以商品页为准</span></div>{product.category && <p className="category-text">{product.category}</p>}<a className="inline-link" href={product.url} target="_blank" rel="noopener noreferrer">查看原商品页面 <ArrowUpRight size={13} /></a></div></div><div className="product-body">{product.features.length > 0 && <section><h4>核心功能</h4><ul className="feature-list">{product.features.map((feature, index) => <li key={index}><Check size={13} /><span>{feature}</span></li>)}</ul></section>}{product.specifications.length > 0 && <details className="detail-accordion"><summary>规格参数 <span>{product.specifications.length} 项</span></summary><dl className="spec-grid">{product.specifications.map((spec) => <div key={spec.name}><dt>{spec.name}</dt><dd>{spec.value}</dd></div>)}</dl></details>}{!product.features.length && product.description && <p className="product-description">{product.description}</p>}{product.imageInsight && <section className="image-insight"><h4><ImageIcon size={14} /> 图片可见信息 <span>视觉模型 · {product.imageInsight.model}</span></h4><ul>{product.imageInsight.observations.map((item, index) => <li key={index}><code>V{index + 1}</code><span>{item}</span></li>)}</ul></section>}<details className="detail-accordion evidence-accordion"><summary>本次采集依据 <span>{product.evidence.length} 条</span></summary><ol>{product.evidence.map((fact) => <li key={fact.id}><code>{fact.id}</code><span><strong>{fact.label}</strong>{fact.value}</span></li>)}</ol></details><div className="source-note"><span><ShieldCheck size={13} />{product.source.provider === "direct" ? "Amazon 公开页面" : product.source.provider === "relay" ? "经取回中转的 Amazon 页面" : "Firecrawl 采集的商品页面"}</span><time dateTime={product.source.fetchedAt}>{new Date(product.source.fetchedAt).toLocaleString("zh-CN", { hour12: false })}</time></div>{product.warnings.map((warning) => <p className="field-warning" key={warning}>{warning}</p>)}</div></article>;
}

function InsightGroup({ title, icon, points }: { title: string; icon: React.ReactNode; points: AnalysisPoint[] }) {
  return <article className="insight-card"><h4>{icon}{title}</h4>{points.map((point, index) => <div className="insight-point" key={index}><h5>{point.title}</h5><p>{point.description}</p><span className="evidence-ref">依据 {point.evidenceIds.join(" · ")}</span></div>)}</article>;
}

function ScriptCard({ content, quality }: { content: Content; quality: Quality | null }) {
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");
  const text = scriptText(content.script);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopyState("done"); } catch { setCopyState("failed"); }
  }
  return <article className="script-card"><div className="script-heading"><div><span className="section-kicker">READY TO SAY IT</span><h3><AudioLines size={19} /> 中文口播文案</h3></div><span className="word-count">{characterCount(text)} <span>/ 150 字</span></span></div><div className="script-content"><span className="hook-label">开头钩子 · {quality ? <>估算 {quality.speech.hookSeconds} 秒{quality.speech.hookWithinFiveSeconds ? "，在 5 秒内" : "，超过 5 秒"}</> : "建议前 5 秒"}</span><p className="script-hook">{content.script.hook}</p><p className="script-body">{content.script.body}</p></div><div className="script-bottom"><span>依据 {content.script.evidenceIds.join(" · ")}{quality && <> · 全文估算 {quality.speech.totalSeconds} 秒</>}</span><button className="copy-button" onClick={copy}>{copyState === "done" ? <Check size={16} /> : <Copy size={16} />}{copyState === "done" ? "已复制文案" : "复制口播文案"}</button></div><p className="copy-feedback" role="status">{copyState === "failed" ? "自动复制未成功，请选中文案手动复制。" : copyState === "done" ? "已复制钩子和正文，不包含标题与证据编号。" : `字数包含钩子、正文、标点与换行${quality ? `；时长按每秒 ${quality.speech.charactersPerSecond} 字估算，实际以真人语速为准` : ""}。`}</p></article>;
}

function QualityPanel({ quality }: { quality: Quality }) {
  const blocking = quality.issues.filter((issue) => issue.severity === "blocking");
  const advisory = quality.issues.filter((issue) => issue.severity === "advisory");
  return <article className={`quality-card ${quality.passed ? "quality-pass" : "quality-warn"}`}>
    <div className="quality-heading">
      <div><span className="section-kicker">CONTENT QUALITY CHECK</span><h3>{quality.passed ? <BadgeCheck size={19} /> : <ShieldAlert size={19} />} 内容质量检查</h3></div>
      <span className="quality-verdict">{quality.passed ? "未发现需要拦截的问题" : `${blocking.length} 项待修正`}</span>
    </div>
    <div className="quality-metrics">
      <div><span>引用依据</span><strong>{quality.evidence.cited} / {quality.evidence.total} 条</strong></div>
      <div><span><Timer size={13} /> 钩子时长</span><strong>{quality.speech.hookSeconds} 秒</strong></div>
      <div><span>全文时长</span><strong>{quality.speech.totalSeconds} 秒</strong></div>
      <div><span>自动修正</span><strong>{quality.revisions} 次</strong></div>
    </div>
    {blocking.length > 0 && <ul className="quality-issues">{blocking.map((issue, index) => <li key={`b${index}`}><span className="quality-tag blocking">待修正</span><div><strong>{issue.field}</strong>「{issue.excerpt}」<p>{issue.message}</p></div></li>)}</ul>}
    {advisory.length > 0 && <ul className="quality-issues">{advisory.map((issue, index) => <li key={`a${index}`}><span className="quality-tag advisory">提示</span><div><strong>{issue.field}</strong>「{issue.excerpt}」<p>{issue.message}</p></div></li>)}</ul>}
    <p className="quality-note">{quality.passed
      ? "已自动核对绝对化措辞、效果承诺、同类对比、材料外数字与价格宣称；检查基于本次采集材料，不代表商品事实已被独立验证。"
      : "以上问题在自动修正后仍然存在，因此如实保留并标注，没有替你改写模型输出。发布前请人工调整这些表述。"}</p>
  </article>;
}
