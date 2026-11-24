import crypto from "crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db/database";
import {
  assertCompanyAccess,
  requireAuth,
  requireRole,
} from "../middleware/auth";
import {
  evaluateInterviewWithAI,
  generateInterviewQuestionsWithAI,
  generatePersonalizedCandidateInterviewQuestions,
} from "../services/ai";
import { GeminiServiceError } from "../services/aiResilience";
import { writeAuditLog } from "../services/audit";
import { sendPlatformEmail } from "../services/email";
import {
  authorizeCandidateInterviewAccess,
  computeRemainingSeconds,
  generateInterviewToken,
  hashInterviewToken,
  maskInterviewToken,
  sanitizeQuestionsForCandidate,
  sanitizeSessionForRecruiter,
} from "../services/interviewAccess";
import type {
  InterviewAnswer,
  InterviewQuestion,
  InterviewQuestionSet,
  InterviewReport,
  InterviewSession,
  JobPosting,
} from "../../../shared/types";

export const interviewsRouter = express.Router();

const interviewSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 90,
  skip: () => config.isTest,
  standardHeaders: true,
  legacyHeaders: false,
});

const ACTIVE_LEASE_TTL_MS = 2 * 60 * 1000;

async function ensurePersonalizedQuestionsInitialized(params: {
  session: InterviewSession;
  job: JobPosting;
  candidateId: string;
  applicationId: string;
}): Promise<InterviewSession> {
  if (
    params.session.questionGenerationStatus === "ready" &&
    params.session.questions.length >= config.interviewMinQuestions
  ) {
    return params.session;
  }

  const questionSet = await db.interviewQuestionSets.findById(
    params.session.questionSetId
  );
  const effectiveSet: InterviewQuestionSet = questionSet ?? {
    id: params.session.questionSetId,
    jobId: params.job.id,
    companyId: params.job.companyId,
    version: params.session.questionSetVersion || 1,
    status: "published",
    durationMinutes: params.session.durationMinutes,
    questions: params.session.questions,
    createdBy: params.session.recruiterId || "system",
    createdAt: params.session.invitedAt,
    updatedAt: params.session.invitedAt,
  };

  const [app, portfolio] = await Promise.all([
    db.applications.findById(params.applicationId),
    db.portfolios.findOne((p) => p.userId === params.candidateId),
  ]);
  const [resumeFile, resumeEvaluation] = app
    ? await Promise.all([
        db.resumeFiles.findById(app.resumeFileId),
        db.resumeEvaluations.findOne((e) => e.applicationId === app.id),
      ])
    : [null, null];

  const generated = await generatePersonalizedCandidateInterviewQuestions({
    job: params.job,
    questionSet: effectiveSet,
    resumeFile,
    resumeEvaluation,
    portfolio,
  });

  const now = new Date().toISOString();
  const updated = await db.interviews.updateById(params.session.id, {
    questions: generated.questions,
    interviewContext: generated.context,
    questionGenerationStatus: "ready",
    questionGenerationErrorSafe: null,
    aiMetadata: generated.aiMetadata,
    auditTrail: [
      ...params.session.auditTrail,
      {
        timestamp: now,
        message: `Generated ${generated.questions.length} personalized candidate interview questions grounded in context.`,
      },
    ],
  });

  return updated ?? params.session;
}

function buildCandidateSessionResponse(params: {
  session: InterviewSession;
  job: JobPosting;
  requestLeaseNonce?: string;
}) {
  const leaseUpdatedMs = params.session.activeSessionUpdatedAt
    ? new Date(params.session.activeSessionUpdatedAt).getTime()
    : 0;
  const hasActiveOtherLease = Boolean(
    params.session.status === "in_progress" &&
      params.session.activeSessionNonce &&
      Date.now() - leaseUpdatedMs < ACTIVE_LEASE_TTL_MS &&
      params.requestLeaseNonce !== params.session.activeSessionNonce
  );

  return {
    session: {
      id: params.session.id,
      status: params.session.status,
      candidateName: params.session.candidateName,
      durationMinutes: params.session.durationMinutes,
      deadlineAt: params.session.deadlineAt,
      startedAt: params.session.startedAt,
      submittedAt: params.session.submittedAt,
      questionGenerationStatus: params.session.questionGenerationStatus ?? "ready",
      evaluationStatus: params.session.evaluationStatus ?? "pending",
      questions: sanitizeQuestionsForCandidate(params.session.questions),
      answers: params.session.answers,
      remainingSeconds: computeRemainingSeconds(params.session),
      tokenHint: params.session.tokenHint,
      activeSessionLocked: hasActiveOtherLease,
    },
    job: {
      id: params.job.id,
      title: params.job.title,
      companyName: params.job.companyName,
      companyVerificationStatus: params.job.companyVerificationStatus,
    },
  };
}

function getHeaderLeaseNonce(req: express.Request): string | undefined {
  const raw = req.headers["x-interview-session-nonce"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

// 1. Recruiter Interview Question Set Setup
interviewsRouter.get(
  "/recruiter/jobs/:jobId/interview-setup",
  requireAuth,
  requireRole("recruiter", "admin"),
  async (req, res) => {
    const job = await db.jobs.findById(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, job.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    const sets = await db.interviewQuestionSets.findMany((s) => s.jobId === job.id);
    sets.sort((a, b) => b.version - a.version);
    res.json({ job, questionSet: sets[0] ?? null, history: sets });
  }
);

interviewsRouter.post(
  "/recruiter/jobs/:jobId/interview-setup/generate",
  requireAuth,
  requireRole("recruiter"),
  async (req, res) => {
    const job = await db.jobs.findById(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, job.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    const rawCount = Number(req.body?.count || 5);
    const count = Number.isFinite(rawCount)
      ? Math.max(
          config.interviewMinQuestions,
          Math.min(config.interviewMaxQuestions, Math.floor(rawCount))
        )
      : 5;
    const profile = job.activeEvaluationProfileId
      ? await db.jobEvaluationProfiles.findById(job.activeEvaluationProfileId)
      : null;

    try {
      const questions = await generateInterviewQuestionsWithAI({ job, profile, count });
      res.json({ questions });
    } catch (err) {
      const statusCode = err instanceof GeminiServiceError ? err.statusCode : 503;
      res.status(statusCode).json({
        error:
          err instanceof Error
            ? err.message
            : "AI question generation failed. You can author questions manually below.",
        allowManualAuthoring: true,
      });
    }
  }
);

interviewsRouter.put(
  "/recruiter/jobs/:jobId/interview-setup",
  requireAuth,
  requireRole("recruiter"),
  async (req, res) => {
    const schema = z
      .object({
        status: z.enum(["draft", "published"]),
        durationMinutes: z
          .number()
          .int()
          .min(10)
          .max(config.interviewMaxDurationMinutes),
        questions: z
          .array(
            z.object({
              id: z.string().min(1),
              prompt: z.string().trim().min(10),
              competency: z.string().trim().min(2),
              rubricSignals: z.array(z.string().trim().min(1)).min(1),
              expectedTimeMinutes: z.number().int().min(2).max(45).optional(),
              category: z.string().trim().min(2).optional(),
              difficulty: z.enum(["foundational", "intermediate", "advanced"]).optional(),
            })
          )
          .min(config.interviewMinQuestions)
          .max(config.interviewMaxQuestions),
      })
      .strict();

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }

    const job = await db.jobs.findById(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, job.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    const existing = await db.interviewQuestionSets.findMany((s) => s.jobId === job.id);
    const nextVersion = existing.reduce((m, s) => Math.max(m, s.version), 0) + 1;
    const now = new Date().toISOString();

    const set: InterviewQuestionSet = {
      id: `qset_${crypto.randomUUID().slice(0, 12)}`,
      jobId: job.id,
      companyId: job.companyId,
      version: nextVersion,
      status: parsed.data.status,
      durationMinutes: parsed.data.durationMinutes,
      questions: parsed.data.questions as InterviewQuestion[],
      createdBy: req.user!.id,
      createdAt: now,
      updatedAt: now,
    };
    await db.interviewQuestionSets.insert(set);

    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: "recruiter",
      action:
        parsed.data.status === "published"
          ? "interview_questions_published"
          : "interview_questions_saved",
      targetType: "job",
      targetId: job.id,
      companyId: job.companyId,
      newState: { questionSetId: set.id, version: set.version },
      requestId: req.requestId,
    });

    res.json({ questionSet: set });
  }
);

// 2. Invitation Management
interviewsRouter.get(
  "/recruiter/jobs/:jobId/interviews",
  requireAuth,
  requireRole("recruiter", "admin"),
  async (req, res) => {
    const job = await db.jobs.findById(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, job.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    const sessions = await db.interviews.findMany((i) => i.jobId === job.id);
    sessions.sort((a, b) => new Date(b.invitedAt).getTime() - new Date(a.invitedAt).getTime());

    const apps = await db.applications.findMany(
      (a) =>
        a.jobId === job.id &&
        a.screeningResult === "qualified" &&
        (a.recruiterDecision === "shortlisted" ||
          a.recruiterDecision === "interview_invited")
    );

    const publishedSets = await db.interviewQuestionSets.findMany(
      (s) => s.jobId === job.id && s.status === "published"
    );
    publishedSets.sort((a, b) => b.version - a.version);

    res.json({
      job,
      sessions: sessions.map((s) => sanitizeSessionForRecruiter(s)),
      eligibleShortlisted: apps,
      hasPublishedQuestionSet: publishedSets.length > 0,
      latestQuestionSet: publishedSets[0] ?? null,
    });
  }
);

interviewsRouter.post(
  "/recruiter/jobs/:jobId/interviews/invite",
  requireAuth,
  requireRole("recruiter"),
  async (req, res) => {
    const schema = z
      .object({
        applicationIds: z.array(z.string().min(1)).min(1),
        deadlineAt: z.string().min(10),
        durationMinutes: z
          .number()
          .int()
          .min(10)
          .max(config.interviewMaxDurationMinutes)
          .optional(),
        simulateEmailFailure: z.boolean().optional(),
      })
      .strict();

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Select at least one shortlisted candidate and a valid future deadline.",
      });
      return;
    }

    const requestedDeadlineMs = new Date(parsed.data.deadlineAt).getTime();
    if (!Number.isFinite(requestedDeadlineMs) || requestedDeadlineMs <= Date.now()) {
      res.status(400).json({ error: "Completion deadline must be in the future." });
      return;
    }

    const maxTtlDeadlineMs =
      Date.now() + config.interviewTokenTtlHours * 60 * 60 * 1000;
    const effectiveDeadlineIso = new Date(
      Math.min(requestedDeadlineMs, maxTtlDeadlineMs)
    ).toISOString();

    const job = await db.jobs.findById(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, job.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    const company = await db.companies.findById(job.companyId);
    if (!company || company.packageCode !== "HATCHLING_FREE") {
      res.status(403).json({ error: "Active Hatchling entitlement required." });
      return;
    }

    const publishedSets = await db.interviewQuestionSets.findMany(
      (s) => s.jobId === job.id && s.status === "published"
    );
    publishedSets.sort((a, b) => b.version - a.version);
    const activeSet = publishedSets[0];
    if (!activeSet) {
      res.status(400).json({
        error: "Publish an interview question set before inviting candidates.",
      });
      return;
    }

    const createdResponses: Array<
      ReturnType<typeof sanitizeSessionForRecruiter> & {
        inviteToken: string;
        inviteUrl: string;
      }
    > = [];

    for (const appId of parsed.data.applicationIds) {
      const app = await db.applications.findById(appId);
      if (!app || app.jobId !== job.id || app.screeningResult !== "qualified") {
        continue;
      }

      const rawToken = generateInterviewToken();
      const tokenHash = hashInterviewToken(rawToken);
      const tokenHint = maskInterviewToken(rawToken);
      const now = new Date().toISOString();
      const duration = parsed.data.durationMinutes ?? activeSet.durationMinutes;

      let initialQuestions = activeSet.questions;
      let questionGenerationStatus: InterviewSession["questionGenerationStatus"] = "pending";
      let questionGenerationErrorSafe: string | null = null;
      let interviewContext: InterviewSession["interviewContext"] | undefined;
      let aiMetadata: InterviewSession["aiMetadata"] | undefined;

      try {
        const [portfolio, resumeFile, resumeEvaluation] = await Promise.all([
          db.portfolios.findOne((p) => p.userId === app.candidateId),
          db.resumeFiles.findById(app.resumeFileId),
          db.resumeEvaluations.findOne((e) => e.applicationId === app.id),
        ]);
        const personalized = await generatePersonalizedCandidateInterviewQuestions({
          job,
          questionSet: activeSet,
          resumeFile,
          resumeEvaluation,
          portfolio,
        });
        initialQuestions = personalized.questions;
        interviewContext = personalized.context;
        aiMetadata = personalized.aiMetadata;
        questionGenerationStatus = "ready";
      } catch (err) {
        questionGenerationStatus = "pending";
        questionGenerationErrorSafe =
          err instanceof Error
            ? err.message
            : "Personalized questions will be generated when the candidate initializes the session.";
      }

      const session: InterviewSession = {
        id: `int_${crypto.randomUUID().slice(0, 12)}`,
        applicationId: app.id,
        jobId: job.id,
        companyId: job.companyId,
        candidateId: app.candidateId,
        candidateName: app.candidateName,
        recruiterId: req.user!.id,
        questionSetId: activeSet.id,
        questionSetVersion: activeSet.version,
        questions: initialQuestions,
        questionGenerationStatus,
        questionGenerationErrorSafe,
        interviewContext,
        aiMetadata,
        tokenHash,
        tokenHint,
        status: "invited",
        evaluationStatus: "pending",
        durationMinutes: duration,
        deadlineAt: effectiveDeadlineIso,
        invitedAt: now,
        startedAt: null,
        submittedAt: null,
        revokedAt: null,
        lastActivityAt: now,
        activeSessionNonce: null,
        activeSessionUpdatedAt: null,
        answers: [],
        emailDeliveryStatus: "pending",
        auditTrail: [
          {
            timestamp: now,
            message: `Invited by recruiter with ${duration}-minute assessment limit.`,
          },
        ],
      };

      const inviteUrl = `${config.frontendUrl}/interview/${rawToken}`;
      const email = await sendPlatformEmail({
        toEmail: app.candidateEmail,
        toName: app.candidateName,
        subject: `AI Text Interview Invitation: ${job.title} at ${job.companyName} — HireZilla`,
        bodyText: `Hi ${app.candidateName},\n\nYou have been invited to complete a written AI-assisted technical interview for ${job.title} at ${job.companyName}.\n\nQuestions: ${initialQuestions.length}\nTime limit once started: ${duration} minutes\nComplete before: ${session.deadlineAt}\nInterview Link: ${inviteUrl}\n\nNote: Sign in with your candidate account (${app.candidateEmail}) to access this session.`,
        templateType: "interview_invite",
        relatedApplicationId: app.id,
        relatedInterviewId: session.id,
        simulateFailure: parsed.data.simulateEmailFailure,
      });

      session.emailDeliveryStatus = email.status === "failed" ? "failed" : "sent";
      await db.interviews.insert(session);
      await db.applications.updateById(app.id, {
        recruiterDecision: "interview_invited",
        applicationStatus: "interview_invited",
        interviewId: session.id,
        interviewStatus: session.status,
        updatedAt: now,
      });

      await writeAuditLog({
        actorId: req.user!.id,
        actorRole: "recruiter",
        action: "interview_invitation_created",
        targetType: "interview",
        targetId: session.id,
        companyId: job.companyId,
        newState: {
          applicationId: app.id,
          candidateId: app.candidateId,
          tokenHint,
          questionGenerationStatus,
        },
        requestId: req.requestId,
      });

      createdResponses.push({
        ...sanitizeSessionForRecruiter(session),
        inviteToken: rawToken,
        inviteUrl,
      });
    }

    res.status(201).json({ invitations: createdResponses });
  }
);

async function reissueInterviewInvitation(params: {
  sessionId: string;
  recruiterId: string;
  companyId?: string;
  customDeadlineAt?: string;
  requestId?: string;
}) {
  const session = await db.interviews.findById(params.sessionId);
  if (!session) {
    return { ok: false as const, statusCode: 404, error: "Interview session not found." };
  }

  if (
    session.status === "submitted" ||
    session.status === "report_ready" ||
    session.status === "report_failed"
  ) {
    return {
      ok: false as const,
      statusCode: 400,
      error: "Cannot reissue an already submitted interview.",
    };
  }

  if (session.status === "revoked") {
    return {
      ok: false as const,
      statusCode: 400,
      error: "Cannot reissue a revoked interview invitation.",
    };
  }

  const app = await db.applications.findById(session.applicationId);
  const job = await db.jobs.findById(session.jobId);
  if (!app || !job) {
    return { ok: false as const, statusCode: 404, error: "Application or job missing." };
  }

  const rawToken = generateInterviewToken();
  const tokenHash = hashInterviewToken(rawToken);
  const tokenHint = maskInterviewToken(rawToken);
  const inviteUrl = `${config.frontendUrl}/interview/${rawToken}`;

  const defaultFutureDeadlineMs =
    Date.now() + config.interviewTokenTtlHours * 60 * 60 * 1000;
  let nextDeadlineIso = session.deadlineAt;
  if (params.customDeadlineAt) {
    const parsedMs = new Date(params.customDeadlineAt).getTime();
    if (!Number.isFinite(parsedMs) || parsedMs <= Date.now()) {
      return {
        ok: false as const,
        statusCode: 400,
        error: "Completion deadline must be in the future.",
      };
    }
    nextDeadlineIso = new Date(Math.min(parsedMs, defaultFutureDeadlineMs)).toISOString();
  } else if (new Date(session.deadlineAt).getTime() <= Date.now()) {
    nextDeadlineIso = new Date(defaultFutureDeadlineMs).toISOString();
  }

  const now = new Date().toISOString();
  const nextStatus = session.status === "expired" ? "invited" : session.status;

  const email = await sendPlatformEmail({
    toEmail: app.candidateEmail,
    toName: app.candidateName,
    subject: `Updated AI Text Interview Invitation (${job.title}) — HireZilla`,
    bodyText: `Hi ${app.candidateName},\n\nHere is your freshly issued interview link for ${job.title} at ${job.companyName}:\n${inviteUrl}\n\nAny previous invitation links for this session are now invalidated.`,
    templateType: "interview_invite",
    relatedApplicationId: app.id,
    relatedInterviewId: session.id,
  });

  const updated = (await db.interviews.updateById(session.id, {
    tokenHash,
    tokenHint,
    token: undefined,
    status: nextStatus,
    deadlineAt: nextDeadlineIso,
    activeSessionNonce: null,
    activeSessionUpdatedAt: null,
    emailDeliveryStatus: email.status === "failed" ? "failed" : "sent",
    auditTrail: [
      ...session.auditTrail,
      { timestamp: now, message: `Invitation token regenerated (${tokenHint}); previous links invalidated.` },
    ],
  }))!;

  await db.applications.updateById(app.id, {
    interviewStatus: nextStatus,
    updatedAt: now,
  });

  await writeAuditLog({
    actorId: params.recruiterId,
    actorRole: "recruiter",
    action: "interview_invitation_regenerated",
    targetType: "interview",
    targetId: session.id,
    companyId: session.companyId,
    newState: { tokenHint, deadlineAt: nextDeadlineIso },
    requestId: params.requestId,
  });

  return {
    ok: true as const,
    session: sanitizeSessionForRecruiter(updated),
    inviteToken: rawToken,
    inviteUrl,
  };
}

interviewsRouter.post(
  "/recruiter/interviews/:interviewId/regenerate",
  requireAuth,
  requireRole("recruiter"),
  async (req, res) => {
    const existing = await db.interviews.findById(req.params.interviewId);
    if (!existing) {
      res.status(404).json({ error: "Interview session not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, existing.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    const result = await reissueInterviewInvitation({
      sessionId: existing.id,
      recruiterId: req.user!.id,
      companyId: existing.companyId,
      customDeadlineAt:
        typeof req.body?.deadlineAt === "string" ? req.body.deadlineAt : undefined,
      requestId: req.requestId,
    });
    if (!result.ok) {
      res.status(result.statusCode).json({ error: result.error });
      return;
    }
    res.json({
      session: result.session,
      inviteToken: result.inviteToken,
      inviteUrl: result.inviteUrl,
    });
  }
);

interviewsRouter.post(
  "/recruiter/interviews/:interviewId/resend",
  requireAuth,
  requireRole("recruiter"),
  async (req, res) => {
    const existing = await db.interviews.findById(req.params.interviewId);
    if (!existing) {
      res.status(404).json({ error: "Interview session not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, existing.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    // Because raw tokens are never stored in DB (§5.1), resend cleanly rotates & emails a fresh token
    const result = await reissueInterviewInvitation({
      sessionId: existing.id,
      recruiterId: req.user!.id,
      companyId: existing.companyId,
      requestId: req.requestId,
    });
    if (!result.ok) {
      res.status(result.statusCode).json({ error: result.error });
      return;
    }
    res.json({
      session: result.session,
      inviteToken: result.inviteToken,
      inviteUrl: result.inviteUrl,
    });
  }
);

interviewsRouter.post(
  "/recruiter/interviews/:interviewId/revoke",
  requireAuth,
  requireRole("recruiter"),
  async (req, res) => {
    const session = await db.interviews.findById(req.params.interviewId);
    if (!session) {
      res.status(404).json({ error: "Interview session not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, session.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    if (session.status === "submitted" || session.status === "report_ready") {
      res.status(400).json({ error: "Cannot revoke a submitted interview." });
      return;
    }

    const now = new Date().toISOString();
    const updated = (await db.interviews.updateById(session.id, {
      status: "revoked",
      revokedAt: now,
      activeSessionNonce: null,
      activeSessionUpdatedAt: null,
      auditTrail: [
        ...session.auditTrail,
        { timestamp: now, message: "Invitation revoked by recruiter." },
      ],
    }))!;
    await db.applications.updateById(session.applicationId, {
      interviewStatus: "revoked",
      updatedAt: now,
    });

    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: "recruiter",
      action: "interview_invitation_revoked",
      targetType: "interview",
      targetId: session.id,
      companyId: session.companyId,
      requestId: req.requestId,
    });

    res.json({ session: sanitizeSessionForRecruiter(updated) });
  }
);

// 3. Shared Candidate Interview Handlers (Token Lookup & Candidate-Authenticated ID Lookup)
async function handleGetInterview(
  req: express.Request,
  res: express.Response,
  lookupMode: "token" | "id",
  identifier: string
) {
  const authz = await authorizeCandidateInterviewAccess({
    user: req.user,
    lookupMode,
    identifier,
    requestId: req.requestId,
  });
  if (!authz.ok) {
    res.status(authz.statusCode).json({ error: authz.error, code: authz.code });
    return;
  }

  let session = authz.session;

  const isCompleted =
    session.status === "submitted" ||
    session.status === "report_ready" ||
    session.status === "report_failed";

  // Idempotent personalized question initialization before start (never regenerates once ready)
  if (!isCompleted && session.questionGenerationStatus !== "ready") {
    try {
      session = await ensurePersonalizedQuestionsInitialized({
        session,
        job: authz.job,
        candidateId: authz.session.candidateId,
        applicationId: authz.application.id,
      });
    } catch (err) {
      await db.interviews.updateById(session.id, {
        questionGenerationStatus: "failed",
        questionGenerationErrorSafe:
          err instanceof Error
            ? err.message
            : "AI interview service is temporarily unavailable.",
      });
      res.status(err instanceof GeminiServiceError ? err.statusCode : 503).json({
        error:
          err instanceof Error
            ? err.message
            : "AI interview service is temporarily unavailable. Your invitation remains valid.",
        code: "AI_SERVICE_UNAVAILABLE",
      });
      return;
    }
  }

  res.json(
    buildCandidateSessionResponse({
      session,
      job: authz.job,
      requestLeaseNonce: getHeaderLeaseNonce(req),
    })
  );
}

async function handleInitializeInterview(
  req: express.Request,
  res: express.Response,
  lookupMode: "token" | "id",
  identifier: string
) {
  const authz = await authorizeCandidateInterviewAccess({
    user: req.user,
    lookupMode,
    identifier,
    requestId: req.requestId,
  });
  if (!authz.ok) {
    res.status(authz.statusCode).json({ error: authz.error, code: authz.code });
    return;
  }

  try {
    const session = await ensurePersonalizedQuestionsInitialized({
      session: authz.session,
      job: authz.job,
      candidateId: authz.session.candidateId,
      applicationId: authz.application.id,
    });
    res.json(
      buildCandidateSessionResponse({
        session,
        job: authz.job,
        requestLeaseNonce: getHeaderLeaseNonce(req),
      })
    );
  } catch (err) {
    await db.interviews.updateById(authz.session.id, {
      questionGenerationStatus: "failed",
      questionGenerationErrorSafe:
        err instanceof Error ? err.message : "AI interview initialization failed.",
    });
    res.status(err instanceof GeminiServiceError ? err.statusCode : 503).json({
      error:
        err instanceof Error
          ? err.message
          : "AI service is temporarily unavailable to initialize questions.",
      code: "AI_SERVICE_UNAVAILABLE",
    });
  }
}

async function handleStartInterview(
  req: express.Request,
  res: express.Response,
  lookupMode: "token" | "id",
  identifier: string
) {
  const authz = await authorizeCandidateInterviewAccess({
    user: req.user,
    lookupMode,
    identifier,
    requestId: req.requestId,
  });
  if (!authz.ok) {
    res.status(authz.statusCode).json({ error: authz.error, code: authz.code });
    return;
  }

  let session = authz.session;
  if (
    session.status === "submitted" ||
    session.status === "report_ready" ||
    session.status === "report_failed"
  ) {
    res.status(409).json({
      error: "This interview has already been submitted.",
      code: "INTERVIEW_ALREADY_SUBMITTED",
    });
    return;
  }

  // Ensure personalized questions are persisted BEFORE starting timer (§8.4 / §11)
  if (session.questionGenerationStatus !== "ready") {
    try {
      session = await ensurePersonalizedQuestionsInitialized({
        session,
        job: authz.job,
        candidateId: session.candidateId,
        applicationId: authz.application.id,
      });
    } catch (err) {
      res.status(err instanceof GeminiServiceError ? err.statusCode : 503).json({
        error:
          err instanceof Error
            ? err.message
            : "AI service unavailable to prepare personalized interview questions.",
        code: "AI_SERVICE_UNAVAILABLE",
      });
      return;
    }
  }

  const incomingNonce = getHeaderLeaseNonce(req);
  const leaseUpdatedMs = session.activeSessionUpdatedAt
    ? new Date(session.activeSessionUpdatedAt).getTime()
    : 0;
  const isOtherActiveLease = Boolean(
    session.status === "in_progress" &&
      session.activeSessionNonce &&
      Date.now() - leaseUpdatedMs < ACTIVE_LEASE_TTL_MS &&
      incomingNonce !== session.activeSessionNonce
  );

  if (isOtherActiveLease) {
    res.status(409).json({
      code: "CONCURRENT_SESSION_CONFLICT",
      error:
        "This interview session is already active in another tab or device. Resume explicitly to transfer control here.",
    });
    return;
  }

  const now = new Date().toISOString();
  const leaseNonce = session.activeSessionNonce || crypto.randomUUID();

  const updated = (await db.interviews.updateById(session.id, {
    status: "in_progress",
    startedAt: session.startedAt ?? now,
    activeSessionNonce: leaseNonce,
    activeSessionUpdatedAt: now,
    lastActivityAt: now,
    auditTrail: session.startedAt
      ? session.auditTrail
      : [...session.auditTrail, { timestamp: now, message: "Candidate started interview timer." }],
  }))!;

  await db.applications.updateById(session.applicationId, {
    interviewStatus: "in_progress",
    updatedAt: now,
  });

  if (!session.startedAt) {
    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: "student",
      action: "interview_started",
      targetType: "interview",
      targetId: session.id,
      companyId: session.companyId,
      requestId: req.requestId,
    });
  }

  res.json({
    ...buildCandidateSessionResponse({
      session: updated,
      job: authz.job,
      requestLeaseNonce: leaseNonce,
    }),
    sessionLeaseNonce: leaseNonce,
    remainingSeconds: computeRemainingSeconds(updated),
  });
}

async function handleResumeInterview(
  req: express.Request,
  res: express.Response,
  lookupMode: "token" | "id",
  identifier: string
) {
  const authz = await authorizeCandidateInterviewAccess({
    user: req.user,
    lookupMode,
    identifier,
    requestId: req.requestId,
  });
  if (!authz.ok) {
    res.status(authz.statusCode).json({ error: authz.error, code: authz.code });
    return;
  }

  let session = authz.session;
  if (
    session.status === "submitted" ||
    session.status === "report_ready" ||
    session.status === "report_failed"
  ) {
    res.status(409).json({
      error: "This interview has already been submitted.",
      code: "INTERVIEW_ALREADY_SUBMITTED",
    });
    return;
  }

  if (session.questionGenerationStatus !== "ready") {
    try {
      session = await ensurePersonalizedQuestionsInitialized({
        session,
        job: authz.job,
        candidateId: session.candidateId,
        applicationId: authz.application.id,
      });
    } catch (err) {
      res.status(err instanceof GeminiServiceError ? err.statusCode : 503).json({
        error:
          err instanceof Error
            ? err.message
            : "AI service unavailable to resume interview.",
        code: "AI_SERVICE_UNAVAILABLE",
      });
      return;
    }
  }

  const now = new Date().toISOString();
  const nextLeaseNonce = crypto.randomUUID();
  const updated = (await db.interviews.updateById(session.id, {
    status: "in_progress",
    startedAt: session.startedAt ?? now,
    activeSessionNonce: nextLeaseNonce,
    activeSessionUpdatedAt: now,
    lastActivityAt: now,
    auditTrail: [
      ...session.auditTrail,
      { timestamp: now, message: "Candidate explicitly resumed active interview lease." },
    ],
  }))!;

  await db.applications.updateById(session.applicationId, {
    interviewStatus: "in_progress",
    updatedAt: now,
  });

  await writeAuditLog({
    actorId: req.user!.id,
    actorRole: "student",
    action: "interview_resumed",
    targetType: "interview",
    targetId: session.id,
    companyId: session.companyId,
    requestId: req.requestId,
  });

  res.json({
    ...buildCandidateSessionResponse({
      session: updated,
      job: authz.job,
      requestLeaseNonce: nextLeaseNonce,
    }),
    sessionLeaseNonce: nextLeaseNonce,
    remainingSeconds: computeRemainingSeconds(updated),
  });
}

async function handleSaveAnswer(
  req: express.Request,
  res: express.Response,
  lookupMode: "token" | "id",
  identifier: string
) {
  const schema = z
    .object({
      questionId: z.string().min(1),
      answerText: z.string().max(15000),
    })
    .strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid answer payload." });
    return;
  }

  const authz = await authorizeCandidateInterviewAccess({
    user: req.user,
    lookupMode,
    identifier,
    requestId: req.requestId,
  });
  if (!authz.ok) {
    res.status(authz.statusCode).json({ error: authz.error, code: authz.code });
    return;
  }

  const session = authz.session;
  if (
    session.status === "submitted" ||
    session.status === "report_ready" ||
    session.status === "report_failed"
  ) {
    res.status(409).json({
      error: "Interview already submitted; answers are locked.",
      code: "INTERVIEW_LOCKED",
    });
    return;
  }

  if (session.activeSessionNonce) {
    const incomingNonce = getHeaderLeaseNonce(req);
    if (incomingNonce !== session.activeSessionNonce) {
      res.status(409).json({
        code: "CONCURRENT_SESSION_CONFLICT",
        error:
          "Another active session controls this interview. Resume the session here to continue editing.",
      });
      return;
    }
  }

  const remaining = computeRemainingSeconds(session);
  if (remaining <= 0) {
    res.status(410).json({ error: "Interview timer has expired.", code: "INTERVIEW_EXPIRED" });
    return;
  }

  const validQuestion = session.questions.some((q) => q.id === parsed.data.questionId);
  if (!validQuestion) {
    res.status(400).json({ error: "Question does not belong to this interview session." });
    return;
  }

  const now = new Date().toISOString();
  const wordCount = parsed.data.answerText.trim()
    ? parsed.data.answerText.trim().split(/\s+/).length
    : 0;

  const answers: InterviewAnswer[] = [...session.answers];
  const idx = answers.findIndex((a) => a.questionId === parsed.data.questionId);
  const nextAns: InterviewAnswer = {
    questionId: parsed.data.questionId,
    answerText: parsed.data.answerText,
    wordCount,
    updatedAt: now,
  };
  if (idx >= 0) answers[idx] = nextAns;
  else answers.push(nextAns);

  const leaseNonce = session.activeSessionNonce || crypto.randomUUID();
  await db.interviews.updateById(session.id, {
    answers,
    status: session.status === "invited" ? "in_progress" : session.status,
    startedAt: session.startedAt ?? now,
    activeSessionNonce: leaseNonce,
    activeSessionUpdatedAt: now,
    lastActivityAt: now,
  });

  res.json({
    savedAt: now,
    wordCount,
    remainingSeconds: remaining,
    sessionLeaseNonce: leaseNonce,
  });
}

async function handleSubmitInterview(
  req: express.Request,
  res: express.Response,
  lookupMode: "token" | "id",
  identifier: string
) {
  const authz = await authorizeCandidateInterviewAccess({
    user: req.user,
    lookupMode,
    identifier,
    requestId: req.requestId,
  });
  if (!authz.ok) {
    res.status(authz.statusCode).json({ error: authz.error, code: authz.code });
    return;
  }

  const session = authz.session;

  // Reject attempts to overwrite/resubmit answers on completed interviews, while keeping empty-body double-click idempotent
  if (
    session.status === "submitted" ||
    session.status === "report_ready" ||
    session.status === "report_failed"
  ) {
    const hasIncomingAnswers =
      Array.isArray(req.body?.answers) && req.body.answers.length > 0;
    if (hasIncomingAnswers) {
      res.status(409).json({
        error: "Completed interviews are immutable and cannot be modified or resubmitted.",
        code: "INTERVIEW_LOCKED",
      });
      return;
    }

    res.json({
      alreadySubmitted: true,
      session: {
        id: session.id,
        status: session.status,
        submittedAt: session.submittedAt,
        evaluationStatus: session.evaluationStatus ?? "ready",
      },
    });
    return;
  }

  if (session.activeSessionNonce) {
    const incomingNonce = getHeaderLeaseNonce(req);
    if (incomingNonce !== session.activeSessionNonce) {
      res.status(409).json({
        code: "CONCURRENT_SESSION_CONFLICT",
        error:
          "Another active session holds the interview lock. Resume here before submitting.",
      });
      return;
    }
  }

  // Persist any final answers bundled in submit call (bounded & question-checked)
  let mergedAnswers = [...session.answers];
  if (Array.isArray(req.body?.answers)) {
    const validQuestionIds = new Set(session.questions.map((q) => q.id));
    for (const incoming of req.body.answers.slice(0, config.interviewMaxQuestions)) {
      if (
        incoming?.questionId &&
        typeof incoming.questionId === "string" &&
        validQuestionIds.has(incoming.questionId) &&
        typeof incoming?.answerText === "string"
      ) {
        const boundedText = incoming.answerText.slice(0, 15000);
        const idx = mergedAnswers.findIndex((a) => a.questionId === incoming.questionId);
        const item: InterviewAnswer = {
          questionId: incoming.questionId,
          answerText: boundedText,
          wordCount: boundedText.trim() ? boundedText.trim().split(/\s+/).length : 0,
          updatedAt: new Date().toISOString(),
        };
        if (idx >= 0) mergedAnswers[idx] = item;
        else mergedAnswers.push(item);
      }
    }
  }

  const now = new Date().toISOString();
  const submittedSession = (await db.interviews.updateById(session.id, {
    answers: mergedAnswers,
    status: "submitted",
    evaluationStatus: "processing",
    evaluationErrorSafe: null,
    submittedAt: now,
    lastActivityAt: now,
    activeSessionNonce: null,
    activeSessionUpdatedAt: null,
    auditTrail: [
      ...session.auditTrail,
      {
        timestamp: now,
        message: `Candidate submitted ${mergedAnswers.length}/${session.questions.length} scenario answers.`,
      },
    ],
  }))!;

  await db.applications.updateById(session.applicationId, {
    applicationStatus: "interview_completed",
    interviewStatus: "submitted",
    updatedAt: now,
  });

  await writeAuditLog({
    actorId: req.user!.id,
    actorRole: "student",
    action: "interview_submitted",
    targetType: "interview",
    targetId: session.id,
    companyId: session.companyId,
    newState: { answeredCount: mergedAnswers.length, questionCount: session.questions.length },
    requestId: req.requestId,
  });

  // Trigger AI interview evaluation (answers remain durably stored even if AI fails)
  const [job, app, portfolio] = await Promise.all([
    db.jobs.findById(session.jobId),
    db.applications.findById(session.applicationId),
    db.portfolios.findOne((p) => p.userId === session.candidateId),
  ]);

  if (job && app) {
    try {
      const reportBody = await evaluateInterviewWithAI({
        job,
        session: submittedSession,
        portfolio,
        atsWeightedScore: app.weightedScore,
      });
      const report: InterviewReport = {
        ...reportBody,
        id: `rep_${crypto.randomUUID().slice(0, 12)}`,
        interviewId: session.id,
        applicationId: app.id,
        jobId: job.id,
        companyId: job.companyId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await db.interviewReports.insert(report);
      await db.interviews.updateById(session.id, {
        status: "report_ready",
        evaluationStatus: "ready",
        evaluationErrorSafe: null,
        reportId: report.id,
        auditTrail: [
          ...submittedSession.auditTrail,
          {
            timestamp: new Date().toISOString(),
            message: "AI Rubric engine evaluated responses and generated recruiter report.",
          },
        ],
      });
      await db.applications.updateById(app.id, {
        interviewStatus: "report_ready",
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      await db.interviews.updateById(session.id, {
        status: "report_failed",
        evaluationStatus: "failed",
        evaluationErrorSafe:
          err instanceof Error
            ? err.message
            : "AI evaluation encountered a temporary error. Answers are safely preserved for retry.",
      });
      await db.applications.updateById(app.id, {
        interviewStatus: "report_failed",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const finalSession = await db.interviews.findById(session.id);
  res.json({
    alreadySubmitted: false,
    session: {
      id: finalSession!.id,
      status: finalSession!.status,
      submittedAt: finalSession!.submittedAt,
      evaluationStatus: finalSession!.evaluationStatus ?? "ready",
    },
  });
}

// Token-based candidate endpoints (email invite URLs)
interviewsRouter.get("/interviews/token/:token", (req, res) =>
  handleGetInterview(req, res, "token", req.params.token)
);
interviewsRouter.post(
  "/interviews/token/:token/initialize",
  interviewSubmitLimiter,
  (req, res) => handleInitializeInterview(req, res, "token", req.params.token)
);
interviewsRouter.post(
  "/interviews/token/:token/start",
  interviewSubmitLimiter,
  (req, res) => handleStartInterview(req, res, "token", req.params.token)
);
interviewsRouter.post(
  "/interviews/token/:token/resume",
  interviewSubmitLimiter,
  (req, res) => handleResumeInterview(req, res, "token", req.params.token)
);
interviewsRouter.put(
  "/interviews/token/:token/answers",
  interviewSubmitLimiter,
  (req, res) => handleSaveAnswer(req, res, "token", req.params.token)
);
interviewsRouter.post(
  "/interviews/token/:token/submit",
  interviewSubmitLimiter,
  (req, res) => handleSubmitInterview(req, res, "token", req.params.token)
);

// ID-based candidate endpoints (authenticated Student Dashboard / Applications launch without raw token storage)
interviewsRouter.get("/interviews/id/:interviewId", (req, res) =>
  handleGetInterview(req, res, "id", req.params.interviewId)
);
interviewsRouter.post(
  "/interviews/id/:interviewId/initialize",
  interviewSubmitLimiter,
  (req, res) => handleInitializeInterview(req, res, "id", req.params.interviewId)
);
interviewsRouter.post(
  "/interviews/id/:interviewId/start",
  interviewSubmitLimiter,
  (req, res) => handleStartInterview(req, res, "id", req.params.interviewId)
);
interviewsRouter.post(
  "/interviews/id/:interviewId/resume",
  interviewSubmitLimiter,
  (req, res) => handleResumeInterview(req, res, "id", req.params.interviewId)
);
interviewsRouter.put(
  "/interviews/id/:interviewId/answers",
  interviewSubmitLimiter,
  (req, res) => handleSaveAnswer(req, res, "id", req.params.interviewId)
);
interviewsRouter.post(
  "/interviews/id/:interviewId/submit",
  interviewSubmitLimiter,
  (req, res) => handleSubmitInterview(req, res, "id", req.params.interviewId)
);

// 4. Recruiter Interview Report View & Action Deck
interviewsRouter.get(
  "/recruiter/applications/:applicationId/interview-report",
  requireAuth,
  requireRole("recruiter", "admin"),
  async (req, res) => {
    const app = await db.applications.findById(req.params.applicationId);
    if (!app) {
      res.status(404).json({ error: "Application not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, app.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    const session = app.interviewId
      ? await db.interviews.findById(app.interviewId)
      : await db.interviews.findOne((i) => i.applicationId === app.id);

    if (!session) {
      res.status(404).json({ error: "No AI text interview found for this application." });
      return;
    }

    const report = session.reportId
      ? await db.interviewReports.findById(session.reportId)
      : await db.interviewReports.findOne((r) => r.interviewId === session.id);

    const job = await db.jobs.findById(app.jobId);

    res.json({
      application: app,
      job,
      session: sanitizeSessionForRecruiter(session),
      report: report ?? null,
    });
  }
);

interviewsRouter.post(
  "/recruiter/applications/:applicationId/interview-report/retry",
  requireAuth,
  requireRole("recruiter"),
  async (req, res) => {
    const app = await db.applications.findById(req.params.applicationId);
    if (!app) {
      res.status(404).json({ error: "Application not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, app.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    const session = await db.interviews.findOne((i) => i.applicationId === app.id);
    const job = await db.jobs.findById(app.jobId);
    if (!session || !job) {
      res.status(404).json({ error: "Interview session not found." });
      return;
    }

    if (
      session.status !== "submitted" &&
      session.status !== "report_failed" &&
      session.status !== "report_ready"
    ) {
      res.status(400).json({ error: "Interview has not been submitted yet." });
      return;
    }

    // Prevent duplicate InterviewReport records on retry (§19.3)
    const existingReport = await db.interviewReports.findOne(
      (r) => r.interviewId === session.id
    );
    if (existingReport) {
      res.json({ report: existingReport, alreadyEvaluated: true });
      return;
    }

    const portfolio = await db.portfolios.findOne((p) => p.userId === app.candidateId);
    try {
      await db.interviews.updateById(session.id, {
        evaluationStatus: "processing",
        evaluationErrorSafe: null,
      });

      const body = await evaluateInterviewWithAI({
        job,
        session,
        portfolio,
        atsWeightedScore: app.weightedScore,
      });
      const report: InterviewReport = {
        ...body,
        id: `rep_${crypto.randomUUID().slice(0, 12)}`,
        interviewId: session.id,
        applicationId: app.id,
        jobId: job.id,
        companyId: job.companyId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await db.interviewReports.insert(report);
      await db.interviews.updateById(session.id, {
        status: "report_ready",
        evaluationStatus: "ready",
        evaluationErrorSafe: null,
        reportId: report.id,
        auditTrail: [
          ...session.auditTrail,
          {
            timestamp: new Date().toISOString(),
            message: "AI interview evaluation retry succeeded.",
          },
        ],
      });
      await db.applications.updateById(app.id, {
        interviewStatus: "report_ready",
        updatedAt: new Date().toISOString(),
      });
      res.json({ report });
    } catch (err) {
      const safeErr =
        err instanceof Error ? err.message : "Failed to evaluate interview.";
      await db.interviews.updateById(session.id, {
        status: "report_failed",
        evaluationStatus: "failed",
        evaluationErrorSafe: safeErr,
      });
      res.status(err instanceof GeminiServiceError ? err.statusCode : 503).json({
        error: safeErr,
      });
    }
  }
);

interviewsRouter.post(
  "/recruiter/applications/:applicationId/interview-report/decision",
  requireAuth,
  requireRole("recruiter"),
  async (req, res) => {
    const schema = z
      .object({
        recommendation: z.enum(["strong_no", "no_hire", "neutral", "hire", "strong"]),
        notes: z.string().max(3000).default(""),
        action: z.enum(["advance_panel", "hold", "not_selected", "save_notes"]),
      })
      .strict();

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid recruiter decision payload." });
      return;
    }

    const app = await db.applications.findById(req.params.applicationId);
    if (!app) {
      res.status(404).json({ error: "Application not found." });
      return;
    }
    const access = await assertCompanyAccess(req.user!, app.companyId);
    if (!access.allowed) {
      res.status(access.statusCode).json({ error: access.message });
      return;
    }

    const report = await db.interviewReports.findOne((r) => r.applicationId === app.id);
    if (report) {
      await db.interviewReports.updateById(report.id, {
        recruiterRecommendation: parsed.data.recommendation,
        recruiterNotes: parsed.data.notes,
        updatedAt: new Date().toISOString(),
      });
    }

    const patch: Record<string, unknown> = {
      recruiterNotes: parsed.data.notes,
      updatedAt: new Date().toISOString(),
    };
    if (parsed.data.action === "advance_panel") {
      patch.recruiterDecision = "selected";
      patch.applicationStatus = "selected";
    } else if (parsed.data.action === "hold") {
      patch.recruiterDecision = "on_hold";
      patch.applicationStatus = "on_hold";
    } else if (parsed.data.action === "not_selected") {
      patch.recruiterDecision = "not_selected";
      patch.applicationStatus = "not_selected";
    }

    const updatedApp = await db.applications.updateById(app.id, patch);

    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: "recruiter",
      action: "interview_report_decision",
      targetType: "application",
      targetId: app.id,
      companyId: app.companyId,
      newState: {
        recommendation: parsed.data.recommendation,
        action: parsed.data.action,
      },
      requestId: req.requestId,
    });

    res.json({
      application: updatedApp,
      report: await db.interviewReports.findOne((r) => r.applicationId === app.id),
    });
  }
);
