import { eventSchema, publicErrorSchema, type AnalysisEvent } from "./contracts";
import { AppError } from "./errors";

export async function consumeAnalysisStream(response: Response, onEvent: (event: AnalysisEvent) => void): Promise<void> {
  if (!response.ok) {
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new AppError("REQUEST_FAILED", "服务暂时没有返回有效响应，请稍后重试。", response.status, true); }
    const parsed = publicErrorSchema.safeParse((payload as { error?: unknown })?.error);
    if (parsed.success) throw new AppError(parsed.data.code, parsed.data.message, response.status, parsed.data.retryable);
    throw new AppError("REQUEST_FAILED", "请求未能完成，请稍后重试。", response.status, true);
  }
  if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) throw new AppError("INVALID_STREAM", "服务器响应格式异常，请重试。", 502, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let hasProduct = false;
  const parseLine = (line: string) => {
    if (!line.trim()) return;
    if (terminal) throw new AppError("INVALID_STREAM", "服务器返回了重复的完成状态。", 502, true);
    const event = eventSchema.parse(JSON.parse(line));
    if (event.type === "product") hasProduct = true;
    if (event.type === "result" && !hasProduct) throw new AppError("INVALID_STREAM", "未取得商品信息，不能展示分析结果。", 502);
    if (event.type === "result" || event.type === "error") terminal = true;
    onEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new AppError("INVALID_STREAM", "响应内容超过处理上限。", 502);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) { parseLine(buffer); break; }
    }
    if (!terminal) throw new AppError("INCOMPLETE_STREAM", "连接提前中断，分析尚未完成。已取得的商品信息仍可查看。", 502, true);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
