import type { PublicError } from "./contracts";

/**
 * Errors whose text is safe to show verbatim. Everything else is replaced with a generic message so
 * an unexpected failure cannot leak internal details.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function publicError(error: unknown): PublicError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
    return { code: "TIMEOUT", message: "本次请求已超时或取消，未生成最终文案。请稍后重试。", retryable: true };
  }
  return { code: "INTERNAL_ERROR", message: "本次分析未能完成，请稍后重试。", retryable: true };
}
