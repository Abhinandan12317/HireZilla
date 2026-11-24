import crypto from "crypto";
import type {
  ApplicationRecord,
  AuthUser,
  InterviewQuestion,
  InterviewSession,
  JobPosting,
} from "../../../shared/types";
import { config } from "../config";
import { db } from "../db/database";
import { writeAuditLog } from "./audit";

export function generateInterviewToken(): string {
  return `HZ-INT-${crypto.randomBytes(24).toString("base64url")}`;
}

export function hashInterviewToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function maskInterviewToken(rawToken: string): string {
  const suffix = rawToken.slice(-4);
  return `HZ-INT-••••${suffix}`;
}

export function constantTimeHashMatch(hashA: string, hashB: string): boolean {
  if (!hashA || !hashB || hashA.length !== hashB.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hashA, "utf8"), Buffer.from(hashB, "utf8"));
  } catch {
    return false;
  }
}

export function computeRemainingSeconds(session: InterviewSession): number {
  const deadlineRemaining = Math.floor(
    (new Date(session.deadlineAt).getTime() - Date.now()) / 1000
  );
  if (!session.startedAt) {
    return Math.max(0, Math.min(deadlineRemaining, session.durationMinutes * 60));
  }
  const durationEnd =
    new Date(session.startedAt).getTime() + session.durationMinutes * 60 * 1000;
  const durationRemaining = Math.floor((durationEnd - Date.now()) / 1000);
  return Math.max(0, Math.min(deadlineRemaining, durationRemaining));
}

export function sanitizeQuestionsForCandidate(
  questions: InterviewQuestion[]
): Array<Pick<InterviewQuestion, "id" | "prompt" | "competency" | "category" | "difficulty" | "expectedTimeMinutes">> {
  // Never reveal internal rubricSignals, evaluationCriteria, or weaknessIndicators to candidates (§8.5)
  return questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    competency: q.competency,
    category: q.category,
    difficulty: q.difficulty,
    expectedTimeMinutes: q.expectedTimeMinutes,
  }));
}

export function sanitizeSessionForRecruiter(
  session: InterviewSession
): Omit<InterviewSession, "tokenHash" | "token" | "activeSessionNonce"> {
  const { tokenHash: _th, token: _t, activeSessionNonce: _n, ...safe } = session;
  return safe;
}

export async function authorizeCandidateInterviewAccess(params: {
  user: AuthUser | null | undefined;
  lookupMode: "token" | "id";
  identifier: string;
  requestId?: string;
}): Promise<
  | {
      ok: true;
      session: InterviewSession;
      application: ApplicationRecord;
      job: JobPosting;
    }
  | {
      ok: false;
      statusCode: number;
      code: string;
      error: string;
    }
> {
  // 1. Authenticate candidate
  if (!params.user) {
    return {
      ok: false,
      statusCode: 401,
      code: "AUTH_REQUIRED",
      error: "Please sign in with your candidate account to access this interview.",
    };
  }
  if (params.user.status === "suspended") {
    return {
      ok: false,
      statusCode: 403,
      code: "ACCOUNT_SUSPENDED",
      error: "Your account is suspended.",
    };
  }
  if (params.user.role !== "student") {
    return {
      ok: false,
      statusCode: 403,
      code: "CANDIDATE_ROLE_REQUIRED",
      error: "Only the invited candidate account may access this interview.",
    };
  }

  // 2. Retrieve interview safely
  let session: InterviewSession | null = null;
  if (params.lookupMode === "token") {
    const incomingHash = hashInterviewToken(params.identifier);
    session = await db.interviews.findOne((s) =>
      s.tokenHash
        ? constantTimeHashMatch(s.tokenHash, incomingHash)
        : s.token === params.identifier
    );
  } else {
    session = await db.interviews.findById(params.identifier);
  }

  if (!session) {
    return {
      ok: false,
      statusCode: 404,
      code: "INTERVIEW_NOT_FOUND",
      error: "Interview invitation is invalid or no longer exists.",
    };
  }

  // 3. Verify interview ownership
  if (session.candidateId !== params.user.id) {
    await writeAuditLog({
      actorId: params.user.id,
      actorRole: params.user.role,
      action: "unauthorized_interview_access",
      targetType: "interview",
      targetId: session.id,
      companyId: session.companyId,
      reason: "Candidate attempted to access an interview bound to another candidate.",
      requestId: params.requestId,
    });
    return {
      ok: false,
      statusCode: 403,
      code: "INTERVIEW_OWNERSHIP_MISMATCH",
      error: "This interview invitation belongs to a different candidate account.",
    };
  }

  // 4. Verify associated application and job/company binding
  const [app, job] = await Promise.all([
    db.applications.findById(session.applicationId),
    db.jobs.findById(session.jobId),
  ]);

  if (
    !app ||
    !job ||
    app.candidateId !== params.user.id ||
    app.jobId !== session.jobId ||
    app.companyId !== session.companyId ||
    job.companyId !== session.companyId
  ) {
    await writeAuditLog({
      actorId: params.user.id,
      actorRole: params.user.role,
      action: "interview_binding_mismatch",
      targetType: "interview",
      targetId: session.id,
      companyId: session.companyId,
      reason: "Interview record binding mismatch with application/job/tenant.",
      requestId: params.requestId,
    });
    return {
      ok: false,
      statusCode: 403,
      code: "INTERVIEW_CONTEXT_MISMATCH",
      error: "Interview context verification failed.",
    };
  }

  // 5. Check revocation
  if (session.status === "revoked") {
    return {
      ok: false,
      statusCode: 403,
      code: "INTERVIEW_REVOKED",
      error: "This interview invitation has been revoked by the hiring team.",
    };
  }

  // 6. Check deadline expiration on every request (for active non-completed states)
  const isFinalized =
    session.status === "submitted" ||
    session.status === "report_ready" ||
    session.status === "report_failed";

  if (!isFinalized) {
    const deadlinePassed = new Date(session.deadlineAt).getTime() < Date.now();
    if (session.status === "expired" || deadlinePassed) {
      if (session.status !== "expired") {
        session =
          (await db.interviews.updateById(session.id, {
            status: "expired",
            auditTrail: [
              ...session.auditTrail,
              { timestamp: new Date().toISOString(), message: "Invitation expired past deadline." },
            ],
          })) ?? session;
        await db.applications.updateById(app.id, {
          interviewStatus: "expired",
          updatedAt: new Date().toISOString(),
        });
      }
      return {
        ok: false,
        statusCode: 410,
        code: "INTERVIEW_EXPIRED",
        error: "This interview invitation deadline has expired.",
      };
    }
  }

  // Check active session TTL if started and still in_progress
  if (session.status === "in_progress" && session.startedAt) {
    const sessionWindowMs = Math.min(
      session.durationMinutes * 60 * 1000,
      config.interviewSessionTtlMinutes * 60 * 1000
    );
    const elapsed = Date.now() - new Date(session.startedAt).getTime();
    if (elapsed > sessionWindowMs && computeRemainingSeconds(session) <= 0) {
      return {
        ok: true,
        session,
        application: app,
        job,
      };
    }
  }

  return {
    ok: true,
    session,
    application: app,
    job,
  };
}
