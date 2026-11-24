import { GoogleGenAI } from "@google/genai";
import { config } from "../config";
import { logEvent } from "./audit";

export type GeminiKeySlot = "primary" | "fallback";

export interface GeminiAttemptMetadata {
  model: string;
  keyUsed: GeminiKeySlot;
  fallbackActivated: boolean;
  attempts: number;
  durationMs: number;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GeminiServiceError extends Error {
  public readonly category:
    | "not_configured"
    | "rate_limit"
    | "quota_exhausted"
    | "timeout"
    | "auth_error"
    | "upstream_5xx"
    | "network_error"
    | "validation_error"
    | "unknown";
  public readonly statusCode: number;
  public readonly eligibleForFallback: boolean;

  constructor(params: {
    message: string;
    category: GeminiServiceError["category"];
    statusCode?: number;
    eligibleForFallback?: boolean;
  }) {
    super(params.message);
    this.name = "GeminiServiceError";
    this.category = params.category;
    this.statusCode = params.statusCode ?? 503;
    this.eligibleForFallback = params.eligibleForFallback ?? false;
  }
}

const clientsByKey = new Map<string, GoogleGenAI>();

export function getGeminiKeyValues(): { primary: string; fallback: string } {
  return {
    primary: config.geminiApiKeyPrimary,
    fallback: config.geminiApiKeyFallback,
  };
}

export function getGeminiClientForKey(apiKey: string): GoogleGenAI {
  if (!apiKey) {
    throw new GeminiServiceError({
      message: "Gemini API key is not configured on the server.",
      category: "not_configured",
      statusCode: 503,
      eligibleForFallback: false,
    });
  }
  let client = clientsByKey.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
    clientsByKey.set(apiKey, client);
  }
  return client;
}

export function classifyGeminiError(err: unknown): {
  category: GeminiServiceError["category"];
  eligibleForFallback: boolean;
  safeMessage: string;
} {
  if (err instanceof GeminiServiceError) {
    return {
      category: err.category,
      eligibleForFallback: err.eligibleForFallback,
      safeMessage: err.message,
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? ((err as { status: number }).status)
      : typeof (err as { statusCode?: unknown })?.statusCode === "number"
        ? ((err as { statusCode: number }).statusCode)
        : undefined;

  if (lower.includes("not configured")) {
    return {
      category: "not_configured",
      eligibleForFallback: false,
      safeMessage: "Gemini API key is not configured on the server.",
    };
  }

  if (
    status === 429 ||
    lower.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota") ||
    lower.includes("rate limit")
  ) {
    const isQuota = lower.includes("quota") || lower.includes("resource_exhausted");
    return {
      category: isQuota ? "quota_exhausted" : "rate_limit",
      eligibleForFallback: true,
      safeMessage: "Gemini AI service is currently rate-limited or quota-exhausted. Please retry shortly.",
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    lower.includes("api_key_invalid") ||
    lower.includes("api key not valid") ||
    lower.includes("permission_denied") ||
    lower.includes("unauthorized")
  ) {
    return {
      category: "auth_error",
      eligibleForFallback: true,
      safeMessage: "Upstream AI credential check failed.",
    };
  }

  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("deadline_exceeded") ||
    lower.includes("etimedout") ||
    lower.includes("abort")
  ) {
    return {
      category: "timeout",
      eligibleForFallback: true,
      safeMessage: "Gemini AI request timed out. Please retry.",
    };
  }

  if (
    (status !== undefined && status >= 500) ||
    /\b50[0234]\b/.test(lower) ||
    lower.includes("internal error") ||
    lower.includes("unavailable") ||
    lower.includes("service unavailable")
  ) {
    return {
      category: "upstream_5xx",
      eligibleForFallback: true,
      safeMessage: "Gemini AI service is temporarily unavailable.",
    };
  }

  if (
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("network")
  ) {
    return {
      category: "network_error",
      eligibleForFallback: true,
      safeMessage: "Network error communicating with Gemini AI service.",
    };
  }

  // Deterministic schema/JSON validation issues should NOT trigger key failover
  if (
    err instanceof SyntaxError ||
    lower.includes("zod") ||
    lower.includes("failed validation") ||
    lower.includes("invalid json") ||
    lower.includes("schema")
  ) {
    return {
      category: "validation_error",
      eligibleForFallback: false,
      safeMessage: "AI response failed structured output validation.",
    };
  }

  return {
    category: "unknown",
    eligibleForFallback: false,
    safeMessage: "AI operation failed unexpectedly.",
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new GeminiServiceError({
              message: `${label} exceeded ${timeoutMs}ms timeout.`,
              category: "timeout",
              statusCode: 504,
              eligibleForFallback: true,
            })
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function executeGeminiWithResilience<T>(params: {
  operationName: string;
  timeoutMs?: number;
  maxRetries?: number;
  execute: (
    client: GoogleGenAI,
    slot: GeminiKeySlot
  ) => Promise<{ result: T; usageMetadata?: GeminiAttemptMetadata["usageMetadata"] }>;
}): Promise<{ result: T; meta: GeminiAttemptMetadata }> {
  const { primary, fallback } = getGeminiKeyValues();
  const timeoutMs = params.timeoutMs ?? config.aiTimeoutMs;
  const maxRetries = params.maxRetries ?? config.aiMaxRetries;

  if (!primary && !fallback) {
    throw new GeminiServiceError({
      message: "GEMINI_API_KEY_PRIMARY / GEMINI_API_KEY is not configured on the server.",
      category: "not_configured",
      statusCode: 503,
      eligibleForFallback: false,
    });
  }

  const startMs = Date.now();
  let totalAttempts = 0;

  const trySlot = async (
    apiKey: string,
    slot: GeminiKeySlot,
    slotMaxRetries: number
  ): Promise<{ ok: true; value: T; usageMetadata?: GeminiAttemptMetadata["usageMetadata"] } | { ok: false; err: unknown; classification: ReturnType<typeof classifyGeminiError> }> => {
    const client = getGeminiClientForKey(apiKey);
    let lastErr: unknown;
    let lastClass: ReturnType<typeof classifyGeminiError> = {
      category: "unknown",
      eligibleForFallback: false,
      safeMessage: "AI error",
    };

    for (let attempt = 0; attempt <= slotMaxRetries; attempt++) {
      totalAttempts++;
      try {
        const res = await withTimeout(
          params.execute(client, slot),
          timeoutMs,
          params.operationName
        );
        return { ok: true, value: res.result, usageMetadata: res.usageMetadata };
      } catch (err) {
        lastErr = err;
        lastClass = classifyGeminiError(err);

        // Immediately stop retrying primary slot on auth/credential failure so we fail over right away
        if (lastClass.category === "auth_error" || lastClass.category === "not_configured") {
          break;
        }
        // Only retry once on validation error; do not loop endlessly
        if (lastClass.category === "validation_error" && attempt >= 1) {
          break;
        }
        if (attempt === slotMaxRetries) {
          break;
        }
        const backoffMs =
          (config.isTest ? 10 : 350) * Math.pow(2, attempt) +
          (config.isTest ? 0 : Math.floor(Math.random() * 150));
        logEvent("warn", "gemini_retry", {
          operationName: params.operationName,
          keySlot: slot,
          attempt: attempt + 1,
          category: lastClass.category,
          backoffMs,
        });
        await sleep(backoffMs);
      }
    }

    return { ok: false, err: lastErr, classification: lastClass };
  };

  // 1. Primary slot
  if (primary) {
    const primaryRes = await trySlot(primary, "primary", maxRetries);
    if (primaryRes.ok) {
      return {
        result: primaryRes.value,
        meta: {
          model: config.geminiModel,
          keyUsed: "primary",
          fallbackActivated: false,
          attempts: totalAttempts,
          durationMs: Date.now() - startMs,
          usageMetadata: primaryRes.usageMetadata,
        },
      };
    }

    // 2. Fallback slot ONLY for eligible upstream/credential/rate/timeout failures
    const canTryFallback =
      Boolean(fallback) &&
      fallback !== primary &&
      primaryRes.classification.eligibleForFallback;

    if (!canTryFallback) {
      throw new GeminiServiceError({
        message: primaryRes.classification.safeMessage,
        category: primaryRes.classification.category,
        statusCode: primaryRes.classification.category === "validation_error" ? 502 : 503,
        eligibleForFallback: false,
      });
    }

    logEvent("warn", "gemini_fallback_activated", {
      operationName: params.operationName,
      primaryFailureCategory: primaryRes.classification.category,
    });

    const fallbackRes = await trySlot(fallback, "fallback", Math.min(1, maxRetries));
    if (fallbackRes.ok) {
      return {
        result: fallbackRes.value,
        meta: {
          model: config.geminiModel,
          keyUsed: "fallback",
          fallbackActivated: true,
          attempts: totalAttempts,
          durationMs: Date.now() - startMs,
          usageMetadata: fallbackRes.usageMetadata,
        },
      };
    }

    throw new GeminiServiceError({
      message: `${fallbackRes.classification.safeMessage} (Primary and fallback Gemini keys unavailable.)`,
      category: fallbackRes.classification.category,
      statusCode: 503,
      eligibleForFallback: false,
    });
  }

  // Only fallback key is configured
  const onlyFallbackRes = await trySlot(fallback, "fallback", maxRetries);
  if (onlyFallbackRes.ok) {
    return {
      result: onlyFallbackRes.value,
      meta: {
        model: config.geminiModel,
        keyUsed: "fallback",
        fallbackActivated: true,
        attempts: totalAttempts,
        durationMs: Date.now() - startMs,
        usageMetadata: onlyFallbackRes.usageMetadata,
      },
    };
  }

  throw new GeminiServiceError({
    message: onlyFallbackRes.classification.safeMessage,
    category: onlyFallbackRes.classification.category,
    statusCode: 503,
    eligibleForFallback: false,
  });
}

/**
 * Word + structural symbol token estimator (not raw character-length division alone).
 * Accounts for BPE subword splits on punctuation, identifiers, camelCase/snake_case, and JSON syntax.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const words = trimmed.split(/\s+/);
  let total = 0;
  for (const w of words) {
    const subParts = w.split(/([._\-/:,;{}()[\]"'`=<>+])/g).filter(Boolean);
    for (const part of subParts) {
      if (part.length <= 4) {
        total += 1;
      } else {
        total += Math.ceil(part.length / 3.6);
      }
    }
  }
  return Math.max(1, Math.ceil(total * 1.08));
}

export interface PrioritizedContextBlock {
  id: string;
  priority: number; // Lower number = higher priority (1 = critical, 5 = optional)
  label: string;
  text: string;
}

export function budgetContextBlocks(params: {
  blocks: PrioritizedContextBlock[];
  maxContextTokens?: number;
  reservedSystemAndOutputTokens?: number;
}): {
  selectedBlocks: PrioritizedContextBlock[];
  estimatedTokensUsed: number;
  omittedCount: number;
  truncated: boolean;
} {
  const maxTotal = params.maxContextTokens ?? config.aiMaxContextTokens;
  const reserved = params.reservedSystemAndOutputTokens ?? 1400;
  const availableBudget = Math.max(400, maxTotal - reserved);

  const sorted = [...params.blocks].sort((a, b) => a.priority - b.priority);
  const selectedBlocks: PrioritizedContextBlock[] = [];
  let usedTokens = 0;
  let omittedCount = 0;
  let truncated = false;

  for (const block of sorted) {
    if (!block.text.trim()) continue;
    const cost = estimateTokens(block.text) + 12;
    if (usedTokens + cost <= availableBudget) {
      selectedBlocks.push(block);
      usedTokens += cost;
    } else if (block.priority <= 2 && availableBudget - usedTokens >= 120) {
      // Trim critical high-priority blocks proportionally to preserve key evidence
      const remainingTokens = availableBudget - usedTokens - 16;
      const words = block.text.split(/\s+/);
      let partial = "";
      for (const word of words) {
        const candidate = partial ? `${partial} ${word}` : word;
        if (estimateTokens(candidate) > remainingTokens) break;
        partial = candidate;
      }
      if (partial.length > 40) {
        selectedBlocks.push({
          ...block,
          text: `${partial} [trimmed to token budget]`,
        });
        usedTokens += estimateTokens(partial) + 16;
      } else {
        omittedCount++;
      }
      truncated = true;
    } else {
      omittedCount++;
      truncated = true;
    }
  }

  return {
    selectedBlocks,
    estimatedTokensUsed: usedTokens + reserved,
    omittedCount,
    truncated,
  };
}
