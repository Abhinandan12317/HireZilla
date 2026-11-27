import crypto from "crypto";
import path from "path";

const ephemeralDevSessionSecret = crypto.randomBytes(32).toString("hex");
const ephemeralDevSignedSecret = crypto.randomBytes(32).toString("hex");

function normalizeSecretValue(val: string | undefined): string {
  const trimmed = (val || "").trim();
  if (
    !trimmed ||
    trimmed === "MY_GEMINI_API_KEY" ||
    trimmed === "REPLACE_WITH_LONG_RANDOM_SECRET"
  ) {
    return "";
  }
  return trimmed;
}

function parsePositiveInt(val: string | undefined, fallback: number, min = 1, max = 1000000): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, Math.floor(n));
}

const parsedCorsOrigins = (process.env.CORS_ORIGIN || process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const nodeEnv = process.env.NODE_ENV || "development";
const hasCrossOriginConfig = parsedCorsOrigins.length > 0;
const cookieSameSiteEnv = process.env.COOKIE_SAME_SITE as "lax" | "strict" | "none" | undefined;
const cookieSameSite: "lax" | "strict" | "none" =
  cookieSameSiteEnv || (hasCrossOriginConfig && nodeEnv === "production" ? "none" : "lax");
const cookieSecure =
  process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE === "true"
    : nodeEnv === "production" || cookieSameSite === "none";

const configuredSessionSecret =
  normalizeSecretValue(process.env.SESSION_SECRET) ||
  normalizeSecretValue(process.env.JWT_SECRET);
const configuredSignedUrlSecret = normalizeSecretValue(process.env.SIGNED_URL_SECRET);

const geminiApiKeyPrimary =
  normalizeSecretValue(process.env.GEMINI_API_KEY_PRIMARY) ||
  normalizeSecretValue(process.env.GEMINI_API_KEY);
const geminiApiKeyFallback = normalizeSecretValue(process.env.GEMINI_API_KEY_FALLBACK);

export const config = {
  port: Number(process.env.BACKEND_PORT || process.env.PORT || 4000),
  nodeEnv,
  isTest: nodeEnv === "test" || Boolean(process.env.VITEST),
  appUrl: process.env.APP_URL || "http://localhost:3000",
  frontendUrl: (process.env.FRONTEND_URL || process.env.APP_URL || "http://localhost:3000").replace(
    /\/+$/,
    ""
  ),
  corsOrigins: parsedCorsOrigins,
  cookieSameSite,
  cookieSecure,
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  mongodbUri: process.env.MONGODB_URI || "",
  mongodbDbName: process.env.MONGODB_DB_NAME || "hirezilla",
  geminiApiKeyPrimary,
  geminiApiKeyFallback,
  /** Backward-compatible primary alias */
  geminiApiKey: geminiApiKeyPrimary,
  geminiModel: "gemini-4-hydrogen" as const,
  googleClientId: process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || "",
  authPasswordEnabled: process.env.AUTH_PASSWORD_ENABLED !== "false",
  sessionSecret: configuredSessionSecret || ephemeralDevSessionSecret,
  signedUrlSecret: configuredSignedUrlSecret || ephemeralDevSignedSecret,
  usingEphemeralSecrets: !configuredSessionSecret || !configuredSignedUrlSecret,
  passwordResetTtlMinutes: parsePositiveInt(process.env.PASSWORD_RESET_TTL_MINUTES, 30, 5, 180),
  interviewTokenTtlHours: parsePositiveInt(process.env.INTERVIEW_TOKEN_TTL_HOURS, 168, 1, 720),
  interviewSessionTtlMinutes: parsePositiveInt(
    process.env.INTERVIEW_SESSION_TTL_MINUTES,
    120,
    10,
    480
  ),
  adminBootstrapEmails: (process.env.ADMIN_BOOTSTRAP_EMAILS || "admin@hirezilla.local")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  resumeMaxSizeBytes: Number(process.env.RESUME_MAX_SIZE_MB || 5) * 1024 * 1024,
  resumeMaxPages: Number(process.env.RESUME_MAX_PAGES || 10),
  ocrEnabled: process.env.OCR_ENABLED === "true",
  privateStorageDir: path.resolve(process.cwd(), "private_storage"),
  dataDir: path.resolve(process.cwd(), "data"),
  signedUrlTtlSeconds: 180,
  aiMaxRetries: parsePositiveInt(process.env.AI_MAX_RETRIES, 2, 0, 5),
  aiTimeoutMs: parsePositiveInt(process.env.AI_REQUEST_TIMEOUT_MS, 25000, 2000, 120000),
  aiMaxContextTokens: parsePositiveInt(process.env.AI_MAX_CONTEXT_TOKENS, 6000, 1000, 32000),
  aiMaxOutputTokens: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS, 3072, 256, 8192),
  interviewMinQuestions: 3,
  interviewMaxQuestions: 8,
  interviewMaxDurationMinutes: 120,
} as const;

export function validateStartupConfig(): { warnings: string[] } {
  const warnings: string[] = [];
  if (config.nodeEnv === "production" && !config.isTest) {
    if (!config.mongodbUri) {
      throw new Error("HireZilla Config] MongoDbURI is required in production");
    }
    if (!configuredSessionSecret || configuredSessionSecret.length < 24) {
      throw new Error(
        "[HireZilla Config] SESSION_SECRET (or JWT_SECRET) >= 24 chars is required in production."
      );
    }
    if (!configuredSignedUrlSecret || configuredSignedUrlSecret.length < 24) {
      throw new Error(
        "[HireZilla Config] SIGNED_URL_SECRET >= 24 chars is required in production."
      );
    }
  } else if (config.usingEphemeralSecrets) {
    warnings.push("Ephemeral session/signed URL secrets active in non-production mode.");
  }

  if (!config.geminiApiKeyPrimary) {
    warnings.push("GEMINI_API_KEY_PRIMARY / GEMINI_API_KEY is not configured.");
  }
  if (!config.geminiApiKeyFallback) {
    warnings.push("GEMINI_API_KEY_FALLBACK is not configured; dual-key failover disabled.");
  }
  return { warnings };
}

