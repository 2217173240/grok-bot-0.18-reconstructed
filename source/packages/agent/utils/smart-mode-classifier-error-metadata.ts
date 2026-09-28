export const SMART_MODE_CLASSIFIER_MANUAL_REVIEW_ERROR_REASON = "An error occured while classifying this action. Please review manually.";
export type SmartModeClassifierFailureKind = "timeout" | "invalid_response" | "provider_failure" | "cancelled";
export class SmartModeClassifierFailure extends Error {
  constructor(readonly kind: SmartModeClassifierFailureKind, readonly timeoutMs?: number) {
    const message = kind === "timeout"
      ? `Auto-review timed out after ${Math.ceil((timeoutMs ?? 0) / 1000)}s. The action was not executed.`
      : kind === "invalid_response"
        ? "Auto-review received an invalid classification response. The action was not executed."
        : kind === "cancelled"
          ? "Auto-review was cancelled. The action was not executed."
          : "The configured provider could not complete Auto-review. The action was not executed.";
    super(message);
    this.name = kind === "cancelled" ? "AbortError" : "SmartModeClassifierFailure";
  }
}
export function smartModeClassifierFailureReason(error: unknown, fallback: string): string {
  return error instanceof SmartModeClassifierFailure ? error.message : fallback;
}
export const METADATA_MARKER = "\n\nSmartModeClassifierFailureMetadata:";
export interface SmartModeClassifierFailureMetadata { failureReason: string | undefined; retryable: boolean | undefined }
export function parseSmartModeClassifierFailureMetadata(error: string | undefined): SmartModeClassifierFailureMetadata | undefined {
  if (error === undefined) return undefined;
  const markerIndex = error.indexOf(METADATA_MARKER);
  if (markerIndex < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(error.slice(markerIndex + METADATA_MARKER.length));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    return {
      failureReason: typeof record.failureReason === "string" ? record.failureReason : undefined,
      retryable: typeof record.retryable === "boolean" ? record.retryable : undefined,
    };
  } catch { return undefined; }
}
