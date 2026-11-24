import argon2 from "argon2";
import crypto from "crypto";
import type { AuthUser } from "../../../shared/types";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

// Configurable Argon2id parameters appropriate for production Node containers
const ARGON2_OPTIONS: Parameters<typeof argon2.hash>[1] & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: Number(process.env.ARGON2_MEMORY_COST || 65536), // 64 MiB
  timeCost: Number(process.env.ARGON2_TIME_COST || 3),
  parallelism: Number(process.env.ARGON2_PARALLELISM || 1),
  hashLength: 32,
  raw: false,
};

// Precomputed dummy Argon2id hash used when an email does not exist so timing matches real verification
const DUMMY_ARGON2_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$YWFhYWFhYWFhYWFhYWFhYQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function validatePasswordInput(password: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof password !== "string") {
    return { valid: false, error: "Password is required." };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      valid: false,
      error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      valid: false,
      error: `Password must not exceed ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }
  if (!password.trim()) {
    return { valid: false, error: "Password cannot be blank whitespace." };
  }
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumberOrSymbol = /[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password);
  if (!hasLetter || !hasNumberOrSymbol) {
    return {
      valid: false,
      error: "Password must include at least one letter and one number or symbol.",
    };
  }
  return { valid: true };
}

export async function hashPassword(password: string): Promise<string> {
  const check = validatePasswordInput(password);
  if (!check.valid) {
    throw new Error(check.error || "Invalid password.");
  }
  const hashed = await argon2.hash(password, ARGON2_OPTIONS);
  return String(hashed);
}

export async function verifyPassword(storedHash: string, candidatePassword: string): Promise<boolean> {
  if (typeof candidatePassword !== "string" || candidatePassword.length === 0 || candidatePassword.length > PASSWORD_MAX_LENGTH) {
    return false;
  }
  try {
    return await argon2.verify(storedHash, candidatePassword);
  } catch {
    return false;
  }
}

export async function verifyPasswordConstantTime(
  storedHash: string | undefined | null,
  candidatePassword: string
): Promise<boolean> {
  if (typeof candidatePassword !== "string" || candidatePassword.length === 0 || candidatePassword.length > PASSWORD_MAX_LENGTH) {
    return false;
  }
  if (!storedHash) {
    try {
      await argon2.verify(DUMMY_ARGON2_HASH, candidatePassword);
    } catch {
      // Ignore dummy verification errors
    }
    return false;
  }
  return verifyPassword(storedHash, candidatePassword);
}

export function generateOpaqueToken(prefix = "", byteLength = 32): string {
  const random = crypto.randomBytes(byteLength).toString("base64url");
  return prefix ? `${prefix}${random}` : random;
}

export function hashOpaqueToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function sanitizeUserForClient(user: AuthUser): Omit<AuthUser, "passwordHash"> {
  const { passwordHash, ...safeUser } = user;
  return {
    ...safeUser,
    hasPassword: Boolean(passwordHash),
    authMethods: user.authMethods ?? (passwordHash ? ["password"] : ["passwordless"]),
    sessionVersion: user.sessionVersion ?? 1,
  };
}
