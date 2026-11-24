import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Lock,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react";
import type { InterviewQuestion } from "../../../shared/types";
import { BrandMark } from "../components/BrandMark";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { ApiError, apiRequest } from "../lib/api";
import { getQueryParam, getRouteParam, routes } from "../lib/navigation";

interface CandidateInterviewPayload {
  session: {
    id: string;
    status: string;
    candidateName: string;
    durationMinutes: number;
    deadlineAt: string;
    startedAt: string | null;
    submittedAt: string | null;
    questionGenerationStatus?: string;
    evaluationStatus?: string;
    questions: Pick<
      InterviewQuestion,
      "id" | "prompt" | "competency" | "category" | "difficulty" | "expectedTimeMinutes"
    >[];
    answers: Array<{ questionId: string; answerText: string; wordCount: number }>;
    remainingSeconds: number;
    tokenHint: string;
    activeSessionLocked?: boolean;
  };
  job: {
    id: string;
    title: string;
    companyName: string;
    companyVerificationStatus: string;
  } | null;
}

export function CandidateInterviewPage() {
  const { user, loading: authLoading } = useAuth();
  const token = getRouteParam("token", /^\/interview\/([^/]+)/);
  const interviewId = getQueryParam("id") || undefined;
  const { pushToast } = useToast();

  const apiBase = token
    ? `/api/interviews/token/${encodeURIComponent(token)}`
    : interviewId
      ? `/api/interviews/id/${encodeURIComponent(interviewId)}`
      : null;

  const leaseStorageKey = token
    ? `hz_int_lease_tok_${token.slice(-12)}`
    : interviewId
      ? `hz_int_lease_id_${interviewId}`
      : null;

  const [leaseNonce, setLeaseNonce] = useState<string | null>(() => {
    if (!leaseStorageKey) return null;
    try {
      return window.sessionStorage.getItem(leaseStorageKey);
    } catch {
      return null;
    }
  });

  const [data, setData] = useState<CandidateInterviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const [stepIdx, setStepIdx] = useState(0);
  const [answersMap, setAnswersMap] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resuming, setResuming] = useState(false);

  const saveLease = (nonce: string | null) => {
    setLeaseNonce(nonce);
    if (!leaseStorageKey) return;
    try {
      if (nonce) window.sessionStorage.setItem(leaseStorageKey, nonce);
      else window.sessionStorage.removeItem(leaseStorageKey);
    } catch {
      // Ignore storage errors
    }
  };

  const buildLeaseHeaders = (): Record<string, string> =>
    leaseNonce ? { "X-Interview-Session-Nonce": leaseNonce } : {};

  const loadSession = useCallback(async () => {
    if (authLoading) return;
    if (!apiBase) {
      setError("Interview invitation link or identifier is missing.");
      setLoading(false);
      return;
    }
    if (!user) {
      setErrorCode("AUTH_REQUIRED");
      setError("Please sign in with the invited candidate account to access this interview.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const res = await apiRequest<CandidateInterviewPayload>(apiBase, {
        headers: buildLeaseHeaders(),
      });
      setData(res);
      setRemainingSeconds(res.session.remainingSeconds);
      const map: Record<string, string> = {};
      for (const a of res.session.answers) {
        map[a.questionId] = a.answerText;
      }
      setAnswersMap(map);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorCode(err.code || null);
      }
      setError(err instanceof Error ? err.message : "Invalid interview link.");
    } finally {
      setLoading(false);
    }
  }, [apiBase, user, authLoading, leaseNonce]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Display countdown synced to server remainingSeconds
  useEffect(() => {
    if (!data || data.session.status !== "in_progress") return;
    const timer = setInterval(() => {
      setRemainingSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [data?.session.status]);

  const handleStart = async () => {
    if (!apiBase) return;
    try {
      const res = await apiRequest<{
        remainingSeconds: number;
        sessionLeaseNonce?: string;
      }>(`${apiBase}/start`, {
        method: "POST",
        headers: buildLeaseHeaders(),
      });
      if (res.sessionLeaseNonce) {
        saveLease(res.sessionLeaseNonce);
      }
      setRemainingSeconds(res.remainingSeconds);
      await loadSession();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONCURRENT_SESSION_CONFLICT") {
        setErrorCode("CONCURRENT_SESSION_CONFLICT");
        await loadSession();
      }
      pushToast("error", err instanceof Error ? err.message : "Could not start interview.");
    }
  };

  const handleResumeLease = async () => {
    if (!apiBase) return;
    setResuming(true);
    try {
      const res = await apiRequest<{
        remainingSeconds: number;
        sessionLeaseNonce: string;
      }>(`${apiBase}/resume`, { method: "POST" });
      saveLease(res.sessionLeaseNonce);
      setRemainingSeconds(res.remainingSeconds);
      pushToast("success", "Interview session transferred to this window.");
      await loadSession();
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "Failed to resume session.");
    } finally {
      setResuming(false);
    }
  };

  const autosaveAnswer = async (questionId: string, answerText: string) => {
    if (!apiBase) return;
    setSaveState("saving");
    try {
      const res = await apiRequest<{
        remainingSeconds: number;
        sessionLeaseNonce?: string;
      }>(`${apiBase}/answers`, {
        method: "PUT",
        headers: buildLeaseHeaders(),
        body: JSON.stringify({ questionId, answerText }),
      });
      if (res.sessionLeaseNonce && res.sessionLeaseNonce !== leaseNonce) {
        saveLease(res.sessionLeaseNonce);
      }
      setRemainingSeconds(res.remainingSeconds);
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      if (err instanceof ApiError && err.code === "CONCURRENT_SESSION_CONFLICT") {
        pushToast(
          "error",
          "Another active session holds the interview lock. Click Resume Here to continue in this tab."
        );
        await loadSession();
      }
    }
  };

  const handleFinalSubmit = async () => {
    if (!apiBase || !data) return;
    setSubmitting(true);
    try {
      const answers = data.session.questions.map((q) => ({
        questionId: q.id,
        answerText: answersMap[q.id] || "",
      }));
      await apiRequest(`${apiBase}/submit`, {
        method: "POST",
        headers: buildLeaseHeaders(),
        body: JSON.stringify({ answers }),
      });
      saveLease(null);
      setConfirmOpen(false);
      pushToast("success", "Interview submitted! Thank you.");
      await loadSession();
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  if (loading || authLoading) {
    return (
      <div className="min-h-screen bg-paper-base flex items-center justify-center p-6">
        <p className="text-sm font-semibold text-on-surface-variant">
          Validating your HireZilla interview session...
        </p>
      </div>
    );
  }

  if (errorCode === "AUTH_REQUIRED" || !user) {
    const returnUrl = `${window.location.pathname}${window.location.search}`;
    return (
      <div className="min-h-screen bg-paper-base flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-surface-card rounded-2xl border border-border-subtle p-8 text-center space-y-4 shadow-xs">
          <Lock className="w-10 h-10 text-primary mx-auto" />
          <h1 className="font-display font-bold text-2xl text-on-surface">
            Candidate Sign-In Required
          </h1>
          <p className="text-sm text-on-surface-variant">
            This interview link is securely bound to the invited candidate account. Sign in to verify ownership and launch your assessment.
          </p>
          <a
            href={routes.login(returnUrl)}
            className="inline-block px-6 py-3 rounded-xl bg-primary-container text-white text-xs font-bold hover:bg-primary"
          >
            Sign In to Continue
          </a>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-paper-base flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-surface-card rounded-2xl border border-border-subtle p-8 text-center space-y-4">
          <AlertCircle className="w-10 h-10 text-status-danger mx-auto" />
          <h1 className="font-display font-bold text-2xl text-on-surface">
            Interview Link Unavailable
          </h1>
          <p className="text-sm text-on-surface-variant">
            {error || "This interview invitation is invalid or expired."}
          </p>
          <div className="flex flex-wrap justify-center gap-2 pt-2">
            {errorCode === "AI_SERVICE_UNAVAILABLE" && (
              <button
                type="button"
                onClick={loadSession}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-primary text-primary text-xs font-bold"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Retry Initialization
              </button>
            )}
            <a
              href={routes.studentApplications}
              className="inline-block px-5 py-2.5 rounded-xl bg-primary-container text-white text-xs font-bold"
            >
              Return to Applications
            </a>
          </div>
        </div>
      </div>
    );
  }

  const { session, job } = data;
  const currentQ = session.questions[stepIdx];

  return (
    <div className="min-h-screen bg-paper-base flex flex-col">
      <header className="bg-surface-card border-b border-border-subtle px-4 sm:px-8 h-[68px] flex items-center justify-between">
        <BrandMark />
        <div className="flex items-center gap-4">
          {session.status === "in_progress" && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary-fixed text-primary font-mono text-sm font-bold tabular-nums">
              <Clock className="w-4 h-4" />
              <span>{formatTime(remainingSeconds)}</span>
            </div>
          )}
          <span className="text-xs font-semibold text-on-surface-variant hidden sm:inline">
            {session.candidateName}
          </span>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-8 py-8">
        {session.status === "submitted" ||
        session.status === "report_ready" ||
        session.status === "report_failed" ? (
          <div className="bg-surface-card rounded-2xl border border-border-subtle p-8 text-center space-y-4 shadow-xs">
            <CheckCircle2 className="w-12 h-12 text-status-success mx-auto" />
            <h1 className="font-display font-bold text-2xl text-on-surface">
              Interview Submitted
            </h1>
            <p className="text-sm text-on-surface-variant max-w-md mx-auto">
              Your written responses for <strong>{job?.title}</strong> at{" "}
              <strong>{job?.companyName}</strong> have been locked and delivered to the hiring team.
            </p>
            <a
              href={routes.studentApplications}
              className="inline-block px-5 py-2.5 rounded-xl bg-primary-container text-white text-xs font-bold"
            >
              View My Applications
            </a>
          </div>
        ) : session.status === "revoked" || session.status === "expired" ? (
          <div className="bg-surface-card rounded-2xl border border-border-subtle p-8 text-center space-y-3">
            <AlertCircle className="w-10 h-10 text-status-danger mx-auto" />
            <h1 className="font-display font-bold text-2xl capitalize">
              Interview {session.status}
            </h1>
            <p className="text-sm text-on-surface-variant">
              This assessment window is no longer active. Contact the hiring team if you need an updated invitation.
            </p>
          </div>
        ) : session.status === "invited" ? (
          <div className="bg-surface-card rounded-2xl border border-border-subtle p-7 sm:p-8 space-y-6 shadow-xs">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                {job?.companyName} (Not verified)
              </span>
              <h1 className="font-display font-bold text-2xl sm:text-3xl text-on-surface mt-1">
                {job?.title} — AI Text Interview
              </h1>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="p-4 rounded-xl bg-paper-base border border-border-subtle">
                <p className="font-bold text-outline uppercase">Questions</p>
                <p className="font-display font-bold text-xl mt-1 tabular-nums">
                  {session.questions.length} Scenarios
                </p>
              </div>
              <div className="p-4 rounded-xl bg-paper-base border border-border-subtle">
                <p className="font-bold text-outline uppercase">Duration</p>
                <p className="font-display font-bold text-xl mt-1 tabular-nums">
                  {session.durationMinutes} Minutes
                </p>
              </div>
              <div className="p-4 rounded-xl bg-paper-base border border-border-subtle">
                <p className="font-bold text-outline uppercase">Deadline</p>
                <p className="font-bold text-sm mt-1 tabular-nums">
                  {new Date(session.deadlineAt).toLocaleDateString()}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-surface-container-low border border-primary/15 flex items-start gap-3 text-xs text-on-surface-variant">
              <ShieldCheck className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                <strong>AI-Assisted Assessment Notice:</strong> Questions are tailored to this role and your submitted profile. Your answers autosave to the server as you type, timer enforcement is server-authoritative, and a human recruiter makes all final hiring decisions.
              </p>
            </div>

            <button
              type="button"
              onClick={handleStart}
              className="px-6 py-3 rounded-xl bg-primary-container text-white font-bold text-sm hover:bg-primary"
            >
              Start Interview
            </button>
          </div>
        ) : session.activeSessionLocked ? (
          <div className="bg-surface-card rounded-2xl border border-status-warning/40 p-8 text-center space-y-4 shadow-xs">
            <Lock className="w-10 h-10 text-status-warning mx-auto" />
            <h1 className="font-display font-bold text-2xl text-on-surface">
              Session Active Elsewhere
            </h1>
            <p className="text-sm text-on-surface-variant max-w-md mx-auto">
              This interview is currently open in another tab or browser window. Resume it here to transfer editing control cleanly without losing your saved answers.
            </p>
            <button
              type="button"
              disabled={resuming}
              onClick={handleResumeLease}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary-container text-white text-xs font-bold hover:bg-primary disabled:opacity-50"
            >
              <RefreshCw className="w-4 h-4" />
              <span>{resuming ? "Transferring Lease..." : "Resume Interview Here"}</span>
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Step Progress Pills */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                {session.questions.map((q, i) => {
                  const answered = Boolean((answersMap[q.id] || "").trim());
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setStepIdx(i)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                        stepIdx === i
                          ? "bg-primary-container text-white"
                          : answered
                            ? "bg-tertiary-fixed text-on-tertiary-fixed"
                            : "bg-surface-card border border-border-subtle text-on-surface-variant"
                      }`}
                    >
                      Q{i + 1}
                    </button>
                  );
                })}
              </div>
              <span className="text-xs font-semibold text-on-surface-variant">
                {saveState === "saving"
                  ? "Saving..."
                  : saveState === "saved"
                    ? "Saved to server"
                    : saveState === "error"
                      ? "Save failed — retry"
                      : `Question ${stepIdx + 1} of ${session.questions.length}`}
              </span>
            </div>

            {/* Active Question Card */}
            {currentQ && (
              <div className="bg-surface-card rounded-2xl border border-border-subtle p-6 sm:p-8 space-y-5 shadow-xs">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-primary">
                    Competency: {currentQ.competency}
                    {currentQ.difficulty ? ` · ${currentQ.difficulty}` : ""}
                  </span>
                  <h2 className="font-display font-bold text-xl text-on-surface mt-1 leading-snug">
                    {currentQ.prompt}
                  </h2>
                </div>

                <div>
                  <label
                    htmlFor="interview-answer"
                    className="block text-xs font-bold text-on-surface mb-1.5"
                  >
                    Your Technical Response
                  </label>
                  <textarea
                    id="interview-answer"
                    rows={10}
                    value={answersMap[currentQ.id] || ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      setAnswersMap((prev) => ({ ...prev, [currentQ.id]: val }));
                    }}
                    onBlur={(e) => autosaveAnswer(currentQ.id, e.target.value)}
                    placeholder="Structure your diagnosis, trade-offs, and implementation details clearly..."
                    className="w-full p-4 rounded-xl bg-paper-base border border-border-subtle text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <div className="flex items-center justify-between mt-2 text-xs text-outline">
                    <span>
                      {(answersMap[currentQ.id] || "").trim()
                        ? `${(answersMap[currentQ.id] || "").trim().split(/\s+/).length} words`
                        : "0 words"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        autosaveAnswer(currentQ.id, answersMap[currentQ.id] || "")
                      }
                      className="text-primary font-bold hover:underline"
                    >
                      Save now
                    </button>
                  </div>
                </div>

                <div className="pt-4 border-t border-border-subtle flex items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={stepIdx === 0}
                    onClick={() => {
                      autosaveAnswer(currentQ.id, answersMap[currentQ.id] || "");
                      setStepIdx((i) => Math.max(0, i - 1));
                    }}
                    className="inline-flex items-center gap-1 px-4 py-2 rounded-lg border border-border-subtle text-xs font-bold disabled:opacity-40"
                  >
                    <ChevronLeft className="w-4 h-4" /> Previous
                  </button>

                  {stepIdx < session.questions.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => {
                        autosaveAnswer(currentQ.id, answersMap[currentQ.id] || "");
                        setStepIdx((i) => Math.min(session.questions.length - 1, i + 1));
                      }}
                      className="inline-flex items-center gap-1 px-5 py-2.5 rounded-xl bg-primary-container text-white text-xs font-bold"
                    >
                      Next Question <ChevronRight className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmOpen(true)}
                      className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl bg-tertiary-fixed text-on-tertiary-fixed text-xs font-bold shadow-xs"
                    >
                      <Send className="w-4 h-4" /> Submit Final Interview
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <ConfirmDialog
        open={confirmOpen}
        title="Submit final interview responses?"
        consequence="Once submitted, your answers are locked and sent for evaluation. You cannot edit responses after final submission."
        confirmLabel="Submit Final Interview"
        loading={submitting}
        onConfirm={handleFinalSubmit}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
