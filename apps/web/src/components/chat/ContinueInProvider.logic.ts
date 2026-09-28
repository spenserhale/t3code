import type { ServerProviderUsageLimits } from "@t3tools/contracts";

// Adapter messages ("Claude usage limit reached", "Codex usage limit reached",
// "Grok usage limit reached") plus the raw wording providers use for the same stop.
const USAGE_LIMIT_ERROR_PATTERN =
  /usage limit|rate[ _-]?limit|session limit|weekly limit|limit reached|quota|too many requests|\b429\b/i;

export function isUsageLimitError(error: string): boolean {
  return USAGE_LIMIT_ERROR_PATTERN.test(error);
}

/**
 * Offer to continue elsewhere only when the thread stopped on an error and the
 * provider looks spent: the error says so, or one of its windows is at 100%.
 */
export function shouldOfferContinueInProvider(input: {
  readonly error: string | null;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
}): boolean {
  if (input.error === null) return false;
  return (
    isUsageLimitError(input.error) ||
    (input.usageLimits?.windows.some((window) => window.usedPercent >= 100) ?? false)
  );
}
