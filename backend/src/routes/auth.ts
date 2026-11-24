import crypto from "crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { AuthUser, PasswordResetTokenRecord, UserRole } from "../../../shared/types";
import { config } from "../config";
import { db } from "../db/database";
import {
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
  verifyGoogleIdToken,
} from "../middleware/auth";
import { logEvent, writeAuditLog } from "../services/audit";
import { sendPlatformEmail } from "../services/email";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  sanitizeUserForClient,
  validatePasswordInput,
  verifyPasswordConstantTime,
} from "../services/passwordAuth";

export const authRouter = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  skip: () => config.isTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication requests. Please try again shortly." },
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  skip: () => config.isTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many password reset requests. Please try again shortly." },
});

function buildAuthConfig() {
  return {
    googleClientId: config.googleClientId || null,
    googleEnabled: Boolean(config.googleClientId),
    demoAuthEnabled: true,
    passwordEnabled: config.authPasswordEnabled,
  };
}

authRouter.get("/me", async (req, res) => {
  if (!req.user) {
    res.json({
      user: null,
      company: null,
      portfolio: null,
      authConfig: buildAuthConfig(),
    });
    return;
  }

  const company = req.user.companyId
    ? await db.companies.findById(req.user.companyId)
    : req.user.role === "recruiter"
      ? await db.companies.findOne(
          (c) => c.ownerUserId === req.user!.id || c.memberUserIds.includes(req.user!.id)
        )
      : null;

  const portfolio =
    req.user.role === "student"
      ? await db.portfolios.findOne((p) => p.userId === req.user!.id)
      : null;

  res.json({
    user: sanitizeUserForClient(req.user),
    company,
    portfolio,
    authConfig: buildAuthConfig(),
  });
});

authRouter.post("/register", authLimiter, async (req, res) => {
  if (!config.authPasswordEnabled) {
    res.status(503).json({ error: "Password registration is currently disabled." });
    return;
  }

  const schema = z
    .object({
      email: z.string().trim().email("Please provide a valid email address."),
      name: z
        .string()
        .trim()
        .min(2, "Name must be at least 2 characters.")
        .max(80, "Name must not exceed 80 characters."),
      password: z.string().max(PASSWORD_MAX_LENGTH, `Password must not exceed ${PASSWORD_MAX_LENGTH} characters.`),
    })
    .strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue?.message || "Invalid registration details." });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const pwValidation = validatePasswordInput(parsed.data.password);
  if (!pwValidation.valid) {
    res.status(400).json({ error: pwValidation.error });
    return;
  }

  if (config.adminBootstrapEmails.includes(email)) {
    // Perform Argon2id timing work anyway to keep response timing balanced
    await hashPassword(parsed.data.password);
    res.status(403).json({
      error: "Unable to complete registration for this address.",
    });
    return;
  }

  const existing = await db.users.findOne((u) => u.email.toLowerCase() === email);
  if (existing) {
    // Perform Argon2id hash work so existing vs new account timing is non-enumerating
    await hashPassword(parsed.data.password);
    res.status(409).json({
      error: "Unable to complete registration with those credentials. Please sign in or reset your password.",
    });
    return;
  }

  const now = new Date().toISOString();
  const passwordHash = await hashPassword(parsed.data.password);
  const user: AuthUser = await db.users.insert({
    id: `usr_${crypto.randomUUID().slice(0, 12)}`,
    email,
    name: parsed.data.name,
    role: null,
    status: "active",
    passwordHash,
    hasPassword: true,
    authMethods: ["password"],
    passwordUpdatedAt: now,
    sessionVersion: 1,
    createdAt: now,
  });

  await writeAuditLog({
    actorId: user.id,
    actorRole: "student",
    action: "user_registered_password",
    targetType: "user",
    targetId: user.id,
    requestId: req.requestId,
  });

  const token = setSessionCookie(res, user);
  res.status(201).json({
    user: sanitizeUserForClient(user),
    token,
    needsRoleSelection: user.role === null,
  });
});

async function handlePasswordLogin(
  req: express.Request,
  res: express.Response,
  email: string,
  password: string
) {
  if (!config.authPasswordEnabled) {
    res.status(503).json({ error: "Password authentication is currently disabled." });
    return;
  }

  if (!password || password.length > PASSWORD_MAX_LENGTH) {
    res.status(400).json({
      error: `Password must be between 1 and ${PASSWORD_MAX_LENGTH} characters.`,
    });
    return;
  }

  const user = await db.users.findOne((u) => u.email.toLowerCase() === email);
  const valid = await verifyPasswordConstantTime(user?.passwordHash, password);

  if (!user || !user.passwordHash || !valid) {
    logEvent("warn", "password_login_failed", {
      emailDomain: email.split("@")[1] || "unknown",
      requestId: req.requestId,
    });
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }

  if (user.status === "suspended") {
    res.status(403).json({ error: "Account is suspended." });
    return;
  }

  const token = setSessionCookie(res, user);
  res.json({
    user: sanitizeUserForClient(user),
    token,
    needsRoleSelection: user.role === null,
  });
}

authRouter.post("/login-password", authLimiter, async (req, res) => {
  const schema = z
    .object({
      email: z.string().trim().email("Please provide a valid email address."),
      password: z
        .string()
        .min(1, "Password is required.")
        .max(PASSWORD_MAX_LENGTH, `Password must not exceed ${PASSWORD_MAX_LENGTH} characters.`),
    })
    .strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue?.message || "Invalid login credentials." });
    return;
  }

  await handlePasswordLogin(
    req,
    res,
    parsed.data.email.toLowerCase(),
    parsed.data.password
  );
});

authRouter.post("/google", authLimiter, async (req, res) => {
  try {
    const bodySchema = z.object({ idToken: z.string().min(10) }).strict();
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Valid Google ID token is required." });
      return;
    }

    const googleUser = await verifyGoogleIdToken(parsed.data.idToken);
    let user = await db.users.findOne((u) => u.email.toLowerCase() === googleUser.email);

    if (!user) {
      const isBootstrapAdmin = config.adminBootstrapEmails.includes(googleUser.email);
      user = await db.users.insert({
        id: `usr_${crypto.randomUUID().slice(0, 12)}`,
        email: googleUser.email,
        name: googleUser.name,
        role: isBootstrapAdmin ? "admin" : null,
        status: "active",
        avatarUrl: googleUser.picture,
        authMethods: ["google"],
        sessionVersion: 1,
        createdAt: new Date().toISOString(),
      });
    } else {
      const methods = new Set(user.authMethods ?? []);
      if (!methods.has("google")) {
        methods.add("google");
        user =
          (await db.users.updateById(user.id, {
            authMethods: Array.from(methods),
            avatarUrl: user.avatarUrl || googleUser.picture,
          })) ?? user;
      }
    }

    if (user.status === "suspended") {
      res.status(403).json({ error: "Your account is currently suspended." });
      return;
    }

    const token = setSessionCookie(res, user);
    res.json({
      user: sanitizeUserForClient(user),
      token,
      needsRoleSelection: user.role === null,
    });
  } catch (err) {
    res.status(401).json({
      error:
        err instanceof Error
          ? err.message
          : "We couldn't sign you in with Google. Please try again.",
    });
  }
});

authRouter.post(["/signup", "/signin", "/login"], authLimiter, async (req, res) => {
  const schema = z
    .object({
      email: z.string().trim().email("Please provide a valid email address."),
      name: z.preprocess(
        (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
        z
          .string()
          .trim()
          .min(2, "Name must be at least 2 characters.")
          .max(80, "Name must not exceed 80 characters.")
          .optional()
      ),
      password: z.preprocess(
        (val) => (typeof val === "string" && val === "" ? undefined : val),
        z.string().max(PASSWORD_MAX_LENGTH).optional()
      ),
    })
    .strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue?.message || "Please provide a valid email address." });
    return;
  }

  const email = parsed.data.email.toLowerCase();

  // If password is supplied on /login or /signin, authenticate via Argon2id
  if (parsed.data.password !== undefined) {
    if (req.path === "/signup") {
      const name = parsed.data.name || email.split("@")[0];
      const pwCheck = validatePasswordInput(parsed.data.password);
      if (!pwCheck.valid) {
        res.status(400).json({ error: pwCheck.error });
        return;
      }
      if (config.adminBootstrapEmails.includes(email)) {
        res.status(403).json({
          error: "Admin accounts require verified Google Sign-In or demo workspace access.",
        });
        return;
      }
      const existing = await db.users.findOne((u) => u.email.toLowerCase() === email);
      if (existing) {
        await hashPassword(parsed.data.password);
        res.status(409).json({
          error: "Unable to complete registration with those credentials. Please sign in or reset your password.",
        });
        return;
      }
      const now = new Date().toISOString();
      const user = await db.users.insert({
        id: `usr_${crypto.randomUUID().slice(0, 12)}`,
        email,
        name: name.length >= 2 ? name : email.split("@")[0],
        role: null,
        status: "active",
        passwordHash: await hashPassword(parsed.data.password),
        hasPassword: true,
        authMethods: ["password"],
        passwordUpdatedAt: now,
        sessionVersion: 1,
        createdAt: now,
      });
      const token = setSessionCookie(res, user);
      res.status(201).json({
        user: sanitizeUserForClient(user),
        token,
        needsRoleSelection: user.role === null,
      });
      return;
    }

    await handlePasswordLogin(req, res, email, parsed.data.password);
    return;
  }

  let user = await db.users.findOne((u) => u.email.toLowerCase() === email);

  // Prevent unverified email login/signup from accessing or provisioning admin accounts
  if (user?.role === "admin" || config.adminBootstrapEmails.includes(email)) {
    res.status(403).json({
      error: "Admin accounts require verified Google Sign-In or demo workspace access.",
    });
    return;
  }

  // Block passwordless bypass once a user has established a password! (§4.4)
  if (user?.passwordHash) {
    res.status(401).json({
      error: "Password is required for this account. Please sign in with your password.",
      passwordRequired: true,
    });
    return;
  }

  if (!user) {
    user = await db.users.insert({
      id: `usr_${crypto.randomUUID().slice(0, 12)}`,
      email,
      name: parsed.data.name || email.split("@")[0],
      role: null,
      status: "active",
      authMethods: ["passwordless"],
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
    });
  }

  if (user.status === "suspended") {
    res.status(403).json({ error: "Account is suspended." });
    return;
  }

  const token = setSessionCookie(res, user);
  res.json({
    user: sanitizeUserForClient(user),
    token,
    needsRoleSelection: user.role === null,
  });
});

authRouter.post("/password/setup", requireAuth, authLimiter, async (req, res) => {
  if (!config.authPasswordEnabled) {
    res.status(503).json({ error: "Password authentication is currently disabled." });
    return;
  }

  const schema = z
    .object({
      currentPassword: z.string().max(PASSWORD_MAX_LENGTH).optional(),
      newPassword: z.string().max(PASSWORD_MAX_LENGTH),
    })
    .strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid password update payload." });
    return;
  }

  const current = await db.users.findById(req.user!.id);
  if (!current) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  // Require current password verification when user already has a password
  if (current.passwordHash) {
    if (!parsed.data.currentPassword) {
      res.status(400).json({ error: "Current password is required to change your password." });
      return;
    }
    const valid = await verifyPasswordConstantTime(
      current.passwordHash,
      parsed.data.currentPassword
    );
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
  }

  const pwCheck = validatePasswordInput(parsed.data.newPassword);
  if (!pwCheck.valid) {
    res.status(400).json({ error: pwCheck.error });
    return;
  }

  const now = new Date().toISOString();
  const nextMethods = new Set(current.authMethods ?? []);
  nextMethods.add("password");
  const nextVersion = (current.sessionVersion ?? 1) + 1;

  const updated = (await db.users.updateById(current.id, {
    passwordHash: await hashPassword(parsed.data.newPassword),
    hasPassword: true,
    authMethods: Array.from(nextMethods),
    passwordUpdatedAt: now,
    sessionVersion: nextVersion,
  })) as AuthUser;

  await writeAuditLog({
    actorId: updated.id,
    actorRole: updated.role ?? "student",
    action: "account_password_updated",
    targetType: "user",
    targetId: updated.id,
    requestId: req.requestId,
  });

  const token = setSessionCookie(res, updated);
  res.json({
    ok: true,
    user: sanitizeUserForClient(updated),
    token,
  });
});

authRouter.post("/password/forgot", resetLimiter, async (req, res) => {
  const schema = z
    .object({
      email: z.string().trim().email("Please provide a valid email address."),
    })
    .strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please provide a valid email address." });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const user = await db.users.findOne((u) => u.email.toLowerCase() === email);

  if (user && user.status === "active") {
    const rawToken = generateOpaqueToken("", 32);
    const tokenHash = hashOpaqueToken(rawToken);
    const now = Date.now();
    const expiresAt = new Date(
      now + config.passwordResetTtlMinutes * 60 * 1000
    ).toISOString();

    const record: PasswordResetTokenRecord = {
      id: `pwr_${crypto.randomUUID().slice(0, 12)}`,
      userId: user.id,
      email: user.email,
      tokenHash,
      expiresAt,
      usedAt: null,
      createdAt: new Date(now).toISOString(),
    };
    await db.passwordResets.insert(record);

    const resetUrl = `${config.frontendUrl}/login?mode=reset&token=${encodeURIComponent(rawToken)}`;
    await sendPlatformEmail({
      toEmail: user.email,
      toName: user.name,
      subject: "Reset your HireZilla password",
      bodyText: `Hi ${user.name},\n\nWe received a request to reset your HireZilla account password.\n\nUse this single-use link within ${config.passwordResetTtlMinutes} minutes:\n${resetUrl}\n\nIf you did not request this, you can safely ignore this message.`,
      templateType: "password_reset",
    });

    await writeAuditLog({
      actorId: user.id,
      actorRole: user.role ?? "student",
      action: "password_reset_requested",
      targetType: "user",
      targetId: user.id,
      requestId: req.requestId,
    });
  }

  // Strictly non-enumerating identical response (§4.2)
  res.json({
    ok: true,
    message: "If an account exists for that email address, password reset instructions have been issued.",
  });
});

authRouter.post("/password/reset", resetLimiter, async (req, res) => {
  if (!config.authPasswordEnabled) {
    res.status(503).json({ error: "Password authentication is currently disabled." });
    return;
  }

  const schema = z
    .object({
      token: z.string().trim().min(16, "Invalid or expired password reset token."),
      newPassword: z.string().max(PASSWORD_MAX_LENGTH),
    })
    .strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue?.message || "Invalid password reset request." });
    return;
  }

  const incomingHash = hashOpaqueToken(parsed.data.token);
  const record = await db.passwordResets.findOne((r) => r.tokenHash === incomingHash);

  if (!record || record.usedAt) {
    res.status(400).json({ error: "Password reset link is invalid or has already been used." });
    return;
  }

  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    res.status(410).json({ error: "Password reset link has expired. Please request a new one." });
    return;
  }

  const user = await db.users.findById(record.userId);
  if (!user || user.status === "suspended") {
    res.status(400).json({ error: "Unable to reset password for this account." });
    return;
  }

  const pwCheck = validatePasswordInput(parsed.data.newPassword);
  if (!pwCheck.valid) {
    res.status(400).json({ error: pwCheck.error });
    return;
  }

  const now = new Date().toISOString();
  // Burn token immediately before updating user credentials
  await db.passwordResets.updateById(record.id, { usedAt: now });

  const nextMethods = new Set(user.authMethods ?? []);
  nextMethods.add("password");
  const nextVersion = (user.sessionVersion ?? 1) + 1;

  await db.users.updateById(user.id, {
    passwordHash: await hashPassword(parsed.data.newPassword),
    hasPassword: true,
    authMethods: Array.from(nextMethods),
    passwordUpdatedAt: now,
    sessionVersion: nextVersion,
  });

  await writeAuditLog({
    actorId: user.id,
    actorRole: user.role ?? "student",
    action: "password_reset_completed",
    targetType: "user",
    targetId: user.id,
    requestId: req.requestId,
  });

  clearSessionCookie(res);
  res.json({
    ok: true,
    message: "Your password has been reset. Please sign in with your new password.",
  });
});

authRouter.post("/demo-signin", authLimiter, async (req, res) => {
  const schema = z
    .object({
      preset: z.enum(["student_arjun", "recruiter_priya", "recruiter_nimbus", "admin"]),
    })
    .strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid demo account preset." });
    return;
  }

  const map: Record<string, string> = {
    student_arjun: "usr_student_arjun",
    recruiter_priya: "usr_recruiter_priya",
    recruiter_nimbus: "usr_recruiter_nimbus",
    admin: "usr_admin_root",
  };

  const user = await db.users.findById(map[parsed.data.preset]);
  if (!user) {
    res.status(404).json({ error: "Demo account not found." });
    return;
  }
  if (user.status === "suspended") {
    res.status(403).json({ error: "Demo account is suspended." });
    return;
  }

  const token = setSessionCookie(res, user);
  res.json({
    user: sanitizeUserForClient(user),
    token,
    needsRoleSelection: user.role === null,
  });
});

authRouter.post("/role", requireAuth, async (req, res) => {
  const schema = z
    .object({
      role: z.enum(["student", "recruiter"]),
    })
    .strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Please select a valid role: Student or Recruiter. Admin cannot be chosen publicly.",
    });
    return;
  }

  const current = await db.users.findById(req.user!.id);
  if (!current) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  if (current.role !== null) {
    res.status(409).json({
      error: `Account role is already set to ${current.role} and cannot be switched casually.`,
    });
    return;
  }

  const role: UserRole = parsed.data.role;
  const updated = (await db.users.updateById(current.id, { role })) as AuthUser;
  const token = setSessionCookie(res, updated);

  await writeAuditLog({
    actorId: updated.id,
    actorRole: role,
    action: "user_role_selected",
    targetType: "user",
    targetId: updated.id,
    newState: { role },
    requestId: req.requestId,
  });

  res.json({ user: sanitizeUserForClient(updated), token });
});

authRouter.post("/logout", async (req, res) => {
  if (req.user) {
    const dbUser = await db.users.findById(req.user.id);
    if (dbUser) {
      await db.users.updateById(dbUser.id, {
        sessionVersion: (dbUser.sessionVersion ?? 1) + 1,
      });
    }
    await writeAuditLog({
      actorId: req.user.id,
      actorRole: req.user.role ?? "student",
      action: "user_logout",
      targetType: "user",
      targetId: req.user.id,
      requestId: req.requestId,
    });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});
