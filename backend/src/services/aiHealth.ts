import { ThinkingLevel } from "@google/genai";
import { config } from "../config";
import { classifyGeminiError, getGeminiClientForKey, getGeminiKeyValues } from "./aiResilience";
import { logEvent } from "./audit";

export type KeyVerificationState = "verified" | "failed" | "unconfigured" | "not_tested";

export interface GeminiHealthReport {
  configured: boolean;
  status: "healthy" | "degraded" | "unconfigured";
  model: string;
  primaryKeyStatus: KeyVerificationState;
  fallbackKeyStatus: KeyVerificationState;
  connectivity: "healthy" | "unhealthy" | "not_configured";
  errorCategory: string | null;
  checkedAt: string | null;
  canRunAiInterviews: boolean;
}

let cachedHealthReport: GeminiHealthReport = {
  configured: Boolean(config.geminiApiKeyPrimary || config.geminiApiKeyFallback),
  status: config.geminiApiKeyPrimary ? "degraded" : "unconfigured",
  model: config.geminiModel,
  primaryKeyStatus: config.geminiApiKeyPrimary ? "not_tested" : "unconfigured",
  fallbackKeyStatus: config.geminiApiKeyFallback ? "not_tested" : "unconfigured",
  connectivity: config.geminiApiKeyPrimary ? "unhealthy" : "not_configured",
  errorCategory: config.geminiApiKeyPrimary ? "pending_verification" : "not_configured",
  checkedAt: null,
  canRunAiInterviews: false,
};

async function testSingleGeminiKey(
  apiKey: string,
  timeoutMs = 10000
): Promise<{ ok: boolean; errorCategory: string | null }> {
  if (!apiKey) {
    return { ok: false, errorCategory: "not_configured" };
  }
  const client = getGeminiClientForKey(apiKey);
  try {
    const response = await Promise.race([
      client.models.generateContent({
        model: config.geminiModel,
        contents: "Respond with OK",
        config: {
          systemInstruction: "Reply with the single word OK.",
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Gemini health check timed out.")), timeoutMs)
      ),
    ]);
    const text = (response.text || "").trim();
    if (!text) {
      return { ok: false, errorCategory: "empty_response" };
    }
    return { ok: true, errorCategory: null };
  } catch (err) {
    const cls = classifyGeminiError(err);
    return { ok: false, errorCategory: cls.category };
  }
}

export async function verifyGeminiDeploymentHealth(
  _opts?: { force?: boolean }
): Promise<GeminiHealthReport> {
  const { primary, fallback } = getGeminiKeyValues();
  const checkedAt = new Date().toISOString();

  if (!primary && !fallback) {
    cachedHealthReport = {
      configured: false,
      status: "unconfigured",
      model: config.geminiModel,
      primaryKeyStatus: "unconfigured",
      fallbackKeyStatus: "unconfigured",
      connectivity: "not_configured",
      errorCategory: "not_configured",
      checkedAt,
      canRunAiInterviews: false,
    };
    logEvent("warn", "gemini_deployment_health_checked", {
      configured: false,
      status: cachedHealthReport.status,
      primaryKeyStatus: cachedHealthReport.primaryKeyStatus,
      fallbackKeyStatus: cachedHealthReport.fallbackKeyStatus,
    });
    return cachedHealthReport;
  }

  let primaryKeyStatus: KeyVerificationState = primary ? "not_tested" : "unconfigured";
  let fallbackKeyStatus: KeyVerificationState = fallback ? "not_tested" : "unconfigured";
  let errorCategory: string | null = null;

  if (primary) {
    const pRes = await testSingleGeminiKey(primary);
    primaryKeyStatus = pRes.ok ? "verified" : "failed";
    if (!pRes.ok) errorCategory = pRes.errorCategory;
  }

  if (fallback) {
    if (fallback === primary) {
      fallbackKeyStatus = primaryKeyStatus;
    } else {
      const fRes = await testSingleGeminiKey(fallback);
      fallbackKeyStatus = fRes.ok ? "verified" : "failed";
      if (!fRes.ok && !errorCategory) errorCategory = fRes.errorCategory;
    }
  }

  const anyVerified = primaryKeyStatus === "verified" || fallbackKeyStatus === "verified";
  const allConfiguredVerified =
    (primary ? primaryKeyStatus === "verified" : true) &&
    (fallback ? fallbackKeyStatus === "verified" : true);

  const status: GeminiHealthReport["status"] = anyVerified
    ? allConfiguredVerified
      ? "healthy"
      : "degraded"
    : "degraded";

  cachedHealthReport = {
    configured: true,
    status,
    model: config.geminiModel,
    primaryKeyStatus,
    fallbackKeyStatus,
    connectivity: anyVerified ? "healthy" : "unhealthy",
    errorCategory: anyVerified ? null : errorCategory,
    checkedAt,
    canRunAiInterviews: anyVerified,
  };

  logEvent(anyVerified ? "info" : "warn", "gemini_deployment_health_checked", {
    configured: true,
    status: cachedHealthReport.status,
    model: config.geminiModel,
    primaryKeyStatus,
    fallbackKeyStatus,
    connectivity: cachedHealthReport.connectivity,
    errorCategory: cachedHealthReport.errorCategory,
  });

  return cachedHealthReport;
}

export function getGeminiHealthReport(): GeminiHealthReport {
  return { ...cachedHealthReport };
}

export function resetGeminiHealthForTests(partial?: Partial<GeminiHealthReport>): void {
  cachedHealthReport = {
    configured: Boolean(config.geminiApiKeyPrimary || config.geminiApiKeyFallback),
    status: "healthy",
    model: config.geminiModel,
    primaryKeyStatus: config.geminiApiKeyPrimary ? "verified" : "unconfigured",
    fallbackKeyStatus: config.geminiApiKeyFallback ? "verified" : "unconfigured",
    connectivity: "healthy",
    errorCategory: null,
    checkedAt: new Date().toISOString(),
    canRunAiInterviews: true,
    ...(partial || {}),
  };
}
