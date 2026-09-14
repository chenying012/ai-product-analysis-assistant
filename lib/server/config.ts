import { AppError } from "../errors";
import type { SetupStatus } from "../contracts";

export type ServerConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  source: "direct" | "firecrawl";
  firecrawlKey: string;
};

export function getSetupStatus(env: Readonly<Record<string, string | undefined>> = process.env): SetupStatus {
  const source = env.PRODUCT_SOURCE === "firecrawl" ? "firecrawl" : "direct";
  return {
    modelConfigured: Boolean(env.OPENAI_API_KEY?.trim() && env.OPENAI_MODEL?.trim()),
    sourceConfigured: source === "direct" || Boolean(env.FIRECRAWL_API_KEY?.trim()),
    source,
    accessProtected: Boolean(env.APP_ACCESS_TOKEN?.trim()),
  };
}

export function getServerConfig(env: Readonly<Record<string, string | undefined>> = process.env): ServerConfig {
  const status = getSetupStatus(env);
  if (!status.modelConfigured) {
    throw new AppError("MODEL_NOT_CONFIGURED", "请先在 .env.local 配置模型的 API Key 和模型名称，然后重启服务。密钥无需填写在网页中。", 503);
  }
  if (env.PRODUCT_SOURCE && !["direct", "firecrawl"].includes(env.PRODUCT_SOURCE)) {
    throw new AppError("SOURCE_NOT_CONFIGURED", "PRODUCT_SOURCE 只能设置为 direct 或 firecrawl。", 503);
  }
  if (!status.sourceConfigured) {
    throw new AppError("SOURCE_NOT_CONFIGURED", "已选择 Firecrawl，但尚未配置 FIRECRAWL_API_KEY。请完成服务端配置后重启。", 503);
  }
  let base: URL;
  try { base = new URL(env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1"); } catch {
    throw new AppError("MODEL_NOT_CONFIGURED", "模型接口地址配置无效，请检查 OPENAI_BASE_URL。", 503);
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new AppError("MODEL_NOT_CONFIGURED", "模型接口必须使用不含账号信息、查询参数或片段的 HTTPS 地址。", 503);
  }
  return {
    apiKey: env.OPENAI_API_KEY!.trim(),
    baseUrl: base.href.replace(/\/$/, ""),
    model: env.OPENAI_MODEL!.trim(),
    source: status.source,
    firecrawlKey: env.FIRECRAWL_API_KEY?.trim() || "",
  };
}
