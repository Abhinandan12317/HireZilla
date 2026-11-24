import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../backend/src/app";
import { db } from "../backend/src/db/database";
import { ensureSeedData } from "../backend/src/services/seed";

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await ensureSeedData();
  app = createApp();
});

describe("Hatchling Auth Hardening (Argon2id Passwords, Reset & Session Invalidation)", () => {
  it("registers user with Argon2id hash, enforces password bounds, prevents enumeration, and verifies login", async () => {
    const email = "argon.candidate@example.com";

    // Weak password rejected
    const weakRes = await request(app).post("/api/auth/register").send({
      email,
      name: "Argon Candidate",
      password: "short",
    });
    expect(weakRes.status).toBe(400);

    // Oversized password (>128 chars) rejected cleanly without DoS hashing
    const longRes = await request(app).post("/api/auth/register").send({
      email,
      name: "Argon Candidate",
      password: `A1${"x".repeat(140)}`,
    });
    expect(longRes.status).toBe(400);

    // Valid registration succeeds and stores $argon2id$ hash (never returned to client)
    const okRes = await request(app).post("/api/auth/register").send({
      email,
      name: "Argon Candidate",
      password: "StrongPassword123!",
    });
    expect(okRes.status).toBe(201);
    expect(okRes.body.user.hasPassword).toBe(true);
    expect(okRes.body.user.passwordHash).toBeUndefined();
    expect(okRes.body.needsRoleSelection).toBe(true);

    const dbUser = await db.users.findById(okRes.body.user.id);
    expect(dbUser?.passwordHash).toBeDefined();
    expect(dbUser?.passwordHash?.startsWith("$argon2id$")).toBe(true);
    expect(dbUser?.passwordHash).not.toContain("StrongPassword123!");

    // Duplicate registration returns uniform non-enumerating 409
    const dupRes = await request(app).post("/api/auth/register").send({
      email,
      name: "Other Name",
      password: "AnotherStrongPassword1!",
    });
    expect(dupRes.status).toBe(409);

    // Passwordless login bypass MUST be rejected for password-protected accounts
    const bypassRes = await request(app).post("/api/auth/signin").send({ email });
    expect(bypassRes.status).toBe(401);
    expect(bypassRes.body.passwordRequired).toBe(true);

    // Wrong password returns uniform 401
    const wrongLogin = await request(app).post("/api/auth/login-password").send({
      email,
      password: "WrongPassword999!",
    });
    expect(wrongLogin.status).toBe(401);
    expect(wrongLogin.body.error).toBe("Invalid email or password.");

    // Missing account login returns identical uniform 401
    const missingLogin = await request(app).post("/api/auth/login-password").send({
      email: "nonexistent.user@example.com",
      password: "WrongPassword999!",
    });
    expect(missingLogin.status).toBe(401);
    expect(missingLogin.body.error).toBe("Invalid email or password.");

    // Valid password login succeeds
    const validLogin = await request(app).post("/api/auth/login-password").send({
      email,
      password: "StrongPassword123!",
    });
    expect(validLogin.status).toBe(200);
    expect(validLogin.body.user.email).toBe(email);
    expect(validLogin.body.user.passwordHash).toBeUndefined();
  });

  it("supports forgot/reset password with single-use hashed expiring tokens and revokes prior sessions", async () => {
    const email = "reset.flow@example.com";
    const regAgent = request.agent(app);
    const reg = await regAgent.post("/api/auth/register").send({
      email,
      name: "Reset Flow User",
      password: "InitialPass123!",
    });
    expect(reg.status).toBe(201);
    const initialBearer = reg.body.token as string;
    await regAgent.post("/api/auth/role").send({ role: "student" });

    // Non-enumerating forgot response for unknown and known emails alike
    const unknownForgot = await request(app)
      .post("/api/auth/password/forgot")
      .send({ email: "never.registered@example.com" });
    const knownForgot = await request(app)
      .post("/api/auth/password/forgot")
      .send({ email });
    expect(unknownForgot.status).toBe(200);
    expect(knownForgot.status).toBe(200);
    expect(unknownForgot.body.message).toBe(knownForgot.body.message);

    // Extract single-use reset token from notification adapter record (not stored plaintext in passwordResets)
    const emails = await db.notifications.findMany(
      (n) => n.toEmail === email && n.templateType === "password_reset"
    );
    expect(emails.length).toBeGreaterThanOrEqual(1);
    const latestEmail = emails[emails.length - 1];
    const match = latestEmail.bodyText.match(/token=([^\s&]+)/);
    expect(match).toBeTruthy();
    const rawResetToken = decodeURIComponent(match![1]);

    // DB record only contains SHA-256 hash, never raw token
    const resetRecords = await db.passwordResets.findMany((r) => r.email === email);
    expect(resetRecords.length).toBeGreaterThanOrEqual(1);
    expect(resetRecords[0].tokenHash).not.toBe(rawResetToken);
    expect(resetRecords[0].tokenHash.length).toBe(64);

    // Valid reset updates password and invalidates prior sessions
    const resetRes = await request(app).post("/api/auth/password/reset").send({
      token: rawResetToken,
      newPassword: "RotatedPassword456!",
    });
    expect(resetRes.status).toBe(200);

    // Reusing same single-use token fails
    const replayRes = await request(app).post("/api/auth/password/reset").send({
      token: rawResetToken,
      newPassword: "ReplayPassword789!",
    });
    expect(replayRes.status).toBe(400);

    // Prior session token is now rejected server-side via sessionVersion rotation
    const staleMe = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${initialBearer}`);
    expect(staleMe.status).toBe(200);
    expect(staleMe.body.user).toBeNull();

    // Old password rejected, new password accepted
    const oldPwLogin = await request(app).post("/api/auth/login-password").send({
      email,
      password: "InitialPass123!",
    });
    expect(oldPwLogin.status).toBe(401);

    const newPwLogin = await request(app).post("/api/auth/login-password").send({
      email,
      password: "RotatedPassword456!",
    });
    expect(newPwLogin.status).toBe(200);

    // Expired reset token is rejected (410)
    await db.passwordResets.insert({
      id: "pwr_expired_test",
      userId: reg.body.user.id,
      email,
      tokenHash: "c".repeat(64),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      usedAt: null,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const crypto = await import("crypto");
    const expiredRaw = "expired-raw-token-for-test-only";
    await db.passwordResets.insert({
      id: "pwr_expired_real",
      userId: reg.body.user.id,
      email,
      tokenHash: crypto.createHash("sha256").update(expiredRaw).digest("hex"),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      usedAt: null,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const expiredAttempt = await request(app).post("/api/auth/password/reset").send({
      token: expiredRaw,
      newPassword: "AnotherValidPassword1!",
    });
    expect(expiredAttempt.status).toBe(410);
  });

  it("allows passwordless/Google accounts to set a password via /password/setup and invalidates tokens on logout", async () => {
    const email = "legacy.passwordless@example.com";
    const agent = request.agent(app);
    const loginRes = await agent.post("/api/auth/signin").send({
      email,
      name: "Legacy Account",
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.hasPassword).toBe(false);
    const oldToken = loginRes.body.token as string;

    const setupRes = await agent.post("/api/auth/password/setup").send({
      newPassword: "NewEstablishedPassword9!",
    });
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.user.hasPassword).toBe(true);
    const rotatedToken = setupRes.body.token as string;
    expect(rotatedToken).not.toBe(oldToken);

    // Logout increments sessionVersion, invalidating even Bearer JWTs!
    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${rotatedToken}`);
    expect(logoutRes.status).toBe(200);

    const postLogoutMe = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${rotatedToken}`);
    expect(postLogoutMe.body.user).toBeNull();
  });
});
