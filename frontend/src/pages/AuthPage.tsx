import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  CheckCircle2,
  Eye,
  EyeOff,
  GraduationCap,
  KeyRound,
  Shield,
  Sparkles,
} from "lucide-react";
import { BrandMark } from "../components/BrandMark";
import { PublicNavbar } from "../components/Layout";
import { useToast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { getQueryParam, navigateTo, routes, sanitizeReturnTo } from "../lib/navigation";

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (cfg: {
            client_id: string;
            callback: (res: { credential?: string }) => void;
          }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

type AuthSubMode = "login" | "signup" | "forgot" | "reset" | "security";

function evaluatePasswordStrength(pw: string): {
  label: string;
  score: number;
  meetsMin: boolean;
} {
  if (!pw) return { label: "Enter password", score: 0, meetsMin: false };
  const hasLen = pw.length >= 8 && pw.length <= 128;
  const hasLetter = /[A-Za-z]/.test(pw);
  const hasNumberOrSymbol = /[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(pw);
  const hasUpperAndLower = /[A-Z]/.test(pw) && /[a-z]/.test(pw);

  let score = 0;
  if (hasLen) score += 1;
  if (hasLetter && hasNumberOrSymbol) score += 1;
  if (hasUpperAndLower) score += 1;
  if (pw.length >= 12) score += 1;

  const meetsMin = hasLen && hasLetter && hasNumberOrSymbol;
  const labels = ["Weak", "Fair", "Good", "Strong", "Very Strong"];
  return { label: labels[score] || "Weak", score, meetsMin };
}

export function AuthPage({ mode = "login" }: { mode?: "login" | "signup" }) {
  const {
    user,
    authConfig,
    demoSignIn,
    registerWithPassword,
    loginWithPassword,
    setupPassword,
    forgotPassword,
    resetPassword,
    emailSignUp,
    googleSignIn,
    selectRole,
  } = useAuth();
  const { pushToast } = useToast();
  const returnTo = sanitizeReturnTo(getQueryParam("returnTo"));
  const queryMode = getQueryParam("mode");
  const resetTokenFromUrl = getQueryParam("token") || "";

  const resolvedInitialMode: AuthSubMode = useMemo(() => {
    if (queryMode === "forgot") return "forgot";
    if (queryMode === "reset" && resetTokenFromUrl) return "reset";
    if (queryMode === "security") return "security";
    return mode;
  }, [queryMode, resetTokenFromUrl, mode]);

  const [subMode, setSubMode] = useState<AuthSubMode>(resolvedInitialMode);
  const [usePasswordless, setUsePasswordless] = useState(false);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [resetToken, setResetToken] = useState(resetTokenFromUrl);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotSentMsg, setForgotSentMsg] = useState<string | null>(null);
  const [resetDoneMsg, setResetDoneMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosenRole, setChosenRole] = useState<"student" | "recruiter" | null>(null);

  const pwStrength = evaluatePasswordStrength(
    subMode === "reset" || subMode === "security" ? confirmPassword : password
  );

  const routeAfterAuth = (role: string | null) => {
    if (returnTo) {
      navigateTo(returnTo);
      return;
    }
    if (role === "recruiter") navigateTo(routes.recruiterDashboard);
    else if (role === "admin") navigateTo(routes.admin());
    else if (role === "student") navigateTo(routes.studentDashboard);
  };

  useEffect(() => {
    if (subMode === "security") return;
    if (user && user.role) {
      routeAfterAuth(user.role);
    }
  }, [user, subMode]);

  useEffect(() => {
    setSubMode(resolvedInitialMode);
  }, [resolvedInitialMode]);

  // Load Google Identity Services button if GOOGLE_CLIENT_ID is configured
  useEffect(() => {
    if (!authConfig.googleEnabled || !authConfig.googleClientId) return;
    const container = document.getElementById("google-signin-btn");
    if (!container) return;

    const initGsi = () => {
      if (!window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: authConfig.googleClientId!,
        callback: async (response) => {
          if (!response.credential) {
            pushToast("error", "We couldn't sign you in. Please try again.");
            return;
          }
          try {
            const res = await googleSignIn(response.credential);
            if (!res.needsRoleSelection) routeAfterAuth(res.user.role);
          } catch (err) {
            pushToast(
              "error",
              err instanceof Error ? err.message : "We couldn't sign you in. Please try again."
            );
          }
        },
      });
      window.google.accounts.id.renderButton(container, {
        theme: "outline",
        size: "large",
        width: 340,
      });
    };

    if (window.google?.accounts?.id) {
      initGsi();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = initGsi;
    document.head.appendChild(script);
  }, [authConfig.googleEnabled, authConfig.googleClientId, subMode]);

  const handlePrimaryAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (subMode === "signup") {
        if (usePasswordless) {
          const res = await emailSignUp(email, name);
          if (!res.needsRoleSelection) routeAfterAuth(res.user.role);
        } else {
          const res = await registerWithPassword({ email, name, password });
          if (!res.needsRoleSelection) routeAfterAuth(res.user.role);
        }
      } else if (subMode === "login") {
        if (usePasswordless) {
          const res = await emailSignUp(email);
          if (!res.needsRoleSelection) routeAfterAuth(res.user.role);
        } else {
          const res = await loginWithPassword({ email, password });
          if (!res.needsRoleSelection) routeAfterAuth(res.user.role);
        }
      }
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await forgotPassword(email);
      setForgotSentMsg(res.message);
      pushToast("success", "Password reset check completed.");
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "Could not process request.");
    } finally {
      setBusy(false);
    }
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await resetPassword({ token: resetToken, newPassword: confirmPassword });
      setResetDoneMsg(res.message);
      pushToast("success", "Password updated. You can now sign in.");
      setSubMode("login");
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await setupPassword({
        currentPassword: user?.hasPassword ? currentPassword : undefined,
        newPassword: confirmPassword,
      });
      pushToast("success", "Account password updated securely.");
      routeAfterAuth(user?.role ?? null);
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "Could not update password.");
    } finally {
      setBusy(false);
    }
  };

  const handleDemoPreset = async (
    preset: "student_arjun" | "recruiter_priya" | "recruiter_nimbus" | "admin"
  ) => {
    setBusy(true);
    try {
      const res = await demoSignIn(preset);
      pushToast("success", `Signed in as ${res.user.name} (${res.user.role}).`);
      routeAfterAuth(res.user.role);
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "Demo sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleRoleContinue = async () => {
    if (!chosenRole) return;
    setBusy(true);
    try {
      await selectRole(chosenRole);
      pushToast("success", `Welcome to HireZilla as a ${chosenRole}!`);
      if (chosenRole === "student") {
        navigateTo(returnTo ?? routes.studentOnboarding());
      } else {
        navigateTo(routes.recruiterCompany);
      }
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "Failed to save role.");
    } finally {
      setBusy(false);
    }
  };

  // Account Password Security Setup/Change screen for already signed-in users
  if (subMode === "security" && user) {
    return (
      <div className="min-h-screen flex flex-col bg-paper-base">
        <PublicNavbar />
        <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
          <div className="w-full max-w-lg bg-surface-card rounded-2xl border border-border-subtle shadow-sm p-7 sm:p-8 space-y-5">
            <div className="flex items-center justify-between">
              <BrandMark />
              <button
                type="button"
                onClick={() => routeAfterAuth(user.role)}
                className="text-xs font-bold text-primary hover:underline inline-flex items-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back to Workspace
              </button>
            </div>

            <div>
              <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-primary">
                <KeyRound className="w-3.5 h-3.5" />
                <span>Account Security</span>
              </div>
              <h1 className="font-display font-bold text-2xl text-on-surface mt-1">
                {user.hasPassword ? "Change your password" : "Set a password for your account"}
              </h1>
              <p className="text-xs text-on-surface-variant mt-1">
                Signed in as <strong>{user.email}</strong>. Setting a password enables email + password sign-in alongside your existing login method.
              </p>
            </div>

            <form onSubmit={handlePasswordSetupSubmit} className="space-y-4">
              {user.hasPassword && (
                <div>
                  <label htmlFor="sec-current-pw" className="block text-xs font-bold mb-1">
                    Current Password
                  </label>
                  <input
                    id="sec-current-pw"
                    type={showPassword ? "text" : "password"}
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-paper-base border border-border-subtle text-sm"
                  />
                </div>
              )}

              <div>
                <label htmlFor="sec-new-pw" className="block text-xs font-bold mb-1">
                  New Password
                </label>
                <div className="relative">
                  <input
                    id="sec-new-pw"
                    type={showPassword ? "text" : "password"}
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="At least 8 chars with a letter and number/symbol"
                    className="w-full px-3.5 py-2.5 pr-10 rounded-lg bg-paper-base border border-border-subtle text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {confirmPassword && (
                  <p
                    className={`text-[11px] mt-1 font-semibold ${
                      pwStrength.meetsMin ? "text-status-success" : "text-status-warning"
                    }`}
                  >
                    Strength: {pwStrength.label} · 8–128 chars, letters + numbers/symbols
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={busy || !pwStrength.meetsMin}
                className="w-full py-3 rounded-xl bg-primary-container text-white font-bold text-sm hover:bg-primary disabled:opacity-50"
              >
                {busy
                  ? "Saving..."
                  : user.hasPassword
                    ? "Update Password & Rotate Sessions"
                    : "Save Password"}
              </button>
            </form>
          </div>
        </main>
      </div>
    );
  }

  // New-user role choice screen (Admin never exposed here)
  if (user && user.role === null) {
    return (
      <div className="min-h-screen flex flex-col bg-paper-base">
        <PublicNavbar />
        <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
          <div className="w-full max-w-2xl bg-surface-card rounded-2xl border border-border-subtle shadow-lg p-8">
            <BrandMark />
            <h1 className="font-display font-bold text-2xl sm:text-3xl text-on-surface mt-6">
              How will you use HireZilla?
            </h1>
            <p className="text-sm text-on-surface-variant mt-1">
              Signed in as <strong>{user.email}</strong>. Select your workspace role to continue.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
              <button
                type="button"
                onClick={() => setChosenRole("student")}
                className={`text-left p-5 rounded-xl border-2 transition-all ${
                  chosenRole === "student"
                    ? "border-primary bg-surface-container-low shadow-sm"
                    : "border-border-subtle hover:border-primary/40 bg-paper-base"
                }`}
              >
                <div className="w-10 h-10 rounded-lg bg-primary-fixed text-primary flex items-center justify-center mb-3">
                  <GraduationCap className="w-5 h-5" />
                </div>
                <p className="font-display font-bold text-lg text-on-surface">
                  Student / Candidate
                </p>
                <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">
                  Build your verified skills &amp; projects portfolio, apply with PDF resumes, and complete AI text interviews.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setChosenRole("recruiter")}
                className={`text-left p-5 rounded-xl border-2 transition-all ${
                  chosenRole === "recruiter"
                    ? "border-primary bg-surface-container-low shadow-sm"
                    : "border-border-subtle hover:border-primary/40 bg-paper-base"
                }`}
              >
                <div className="w-10 h-10 rounded-lg bg-tertiary-fixed text-on-tertiary-fixed flex items-center justify-center mb-3">
                  <Briefcase className="w-5 h-5" />
                </div>
                <p className="font-display font-bold text-lg text-on-surface">Recruiter</p>
                <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">
                  Set up your company workspace, publish jobs with dynamic rubrics, review ATS evidence, and invite candidates.
                </p>
              </button>
            </div>

            <div className="mt-6 flex items-center justify-between gap-4">
              <p className="text-xs text-outline">
                Role is locked after onboarding to preserve workspace isolation.
              </p>
              <button
                type="button"
                disabled={!chosenRole || busy}
                onClick={handleRoleContinue}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary-container text-white font-bold text-sm hover:bg-primary transition-colors disabled:opacity-50"
              >
                <span>{busy ? "Saving..." : "Continue"}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-paper-base">
      <PublicNavbar />
      <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* Primary Auth Panel */}
          <div className="lg:col-span-7 bg-surface-card rounded-2xl border border-border-subtle shadow-sm p-7 sm:p-8 flex flex-col justify-between">
            <div>
              <BrandMark showTagline />
              <h1 className="font-display font-bold text-2xl sm:text-3xl text-on-surface mt-6">
                {subMode === "signup"
                  ? "Create your HireZilla account"
                  : subMode === "forgot"
                    ? "Reset your password"
                    : subMode === "reset"
                      ? "Choose a new password"
                      : "Sign in to HireZilla"}
              </h1>
              <p className="text-sm text-on-surface-variant mt-1">
                {subMode === "forgot"
                  ? "Enter your account email and we will issue single-use reset instructions."
                  : subMode === "reset"
                    ? "Your previous active sessions will be invalidated once updated."
                    : "One account for candidate portfolios or company recruiting workspaces."}
              </p>

              {resetDoneMsg && (
                <div className="mt-4 p-3 rounded-xl bg-status-success/10 border border-status-success/30 text-xs font-semibold text-status-success flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{resetDoneMsg}</span>
                </div>
              )}

              {(subMode === "login" || subMode === "signup") && (
                <>
                  {authConfig.googleEnabled ? (
                    <div className="mt-5">
                      <div id="google-signin-btn" />
                    </div>
                  ) : (
                    <div className="mt-4 p-3 rounded-lg bg-surface-container-low border border-border-subtle text-xs text-on-surface-variant">
                      Sign in with your email and Argon2id password, or use Google / demo workspaces below.
                    </div>
                  )}

                  <form onSubmit={handlePrimaryAuthSubmit} className="mt-5 space-y-4">
                    {subMode === "signup" && (
                      <div>
                        <label
                          htmlFor="auth-name"
                          className="block text-xs font-bold text-on-surface mb-1"
                        >
                          Full Name <span className="text-status-danger">*</span>
                        </label>
                        <input
                          id="auth-name"
                          type="text"
                          required
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="e.g. Ananya Verma"
                          className="w-full px-3.5 py-2.5 rounded-lg bg-paper-base border border-border-subtle text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                        />
                      </div>
                    )}

                    <div>
                      <label
                        htmlFor="auth-email"
                        className="block text-xs font-bold text-on-surface mb-1"
                      >
                        Email Address <span className="text-status-danger">*</span>
                      </label>
                      <input
                        id="auth-email"
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        className="w-full px-3.5 py-2.5 rounded-lg bg-paper-base border border-border-subtle text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </div>

                    {!usePasswordless && authConfig.passwordEnabled && (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label
                            htmlFor="auth-password"
                            className="block text-xs font-bold text-on-surface"
                          >
                            Password <span className="text-status-danger">*</span>
                          </label>
                          {subMode === "login" && (
                            <button
                              type="button"
                              onClick={() => {
                                setForgotSentMsg(null);
                                setSubMode("forgot");
                              }}
                              className="text-xs font-semibold text-primary hover:underline"
                            >
                              Forgot password?
                            </button>
                          )}
                        </div>
                        <div className="relative">
                          <input
                            id="auth-password"
                            type={showPassword ? "text" : "password"}
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={
                              subMode === "signup"
                                ? "Min 8 chars, include letter + number/symbol"
                                : "Enter your password"
                            }
                            className="w-full px-3.5 py-2.5 pr-10 rounded-lg bg-paper-base border border-border-subtle text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            aria-label={showPassword ? "Hide password" : "Show password"}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface"
                          >
                            {showPassword ? (
                              <EyeOff className="w-4 h-4" />
                            ) : (
                              <Eye className="w-4 h-4" />
                            )}
                          </button>
                        </div>

                        {subMode === "signup" && (
                          <p
                            className={`text-[11px] mt-1 font-medium ${
                              password
                                ? pwStrength.meetsMin
                                  ? "text-status-success"
                                  : "text-status-warning"
                                : "text-outline"
                            }`}
                          >
                            {password
                              ? `Password strength: ${pwStrength.label}`
                              : "Use 8–128 characters with at least one letter and one number or symbol."}
                          </p>
                        )}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={busy}
                      className="w-full py-3 rounded-xl bg-primary-container text-white font-bold text-sm hover:bg-primary transition-colors disabled:opacity-60"
                    >
                      {busy
                        ? "Authenticating..."
                        : subMode === "signup"
                          ? usePasswordless
                            ? "Continue without Password"
                            : "Create Account"
                          : usePasswordless
                            ? "Sign in with Email Only"
                            : "Sign in"}
                    </button>

                    <div className="flex items-center justify-between text-xs">
                      <button
                        type="button"
                        onClick={() => setUsePasswordless((v) => !v)}
                        className="text-on-surface-variant hover:text-primary font-semibold underline-offset-2 hover:underline"
                      >
                        {usePasswordless
                          ? "Use Email + Password instead"
                          : "Use Passwordless Email Access"}
                      </button>
                    </div>
                  </form>
                </>
              )}

              {subMode === "forgot" && (
                <form onSubmit={handleForgotSubmit} className="mt-6 space-y-4">
                  <div>
                    <label htmlFor="forgot-email" className="block text-xs font-bold mb-1">
                      Account Email Address
                    </label>
                    <input
                      id="forgot-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full px-3.5 py-2.5 rounded-lg bg-paper-base border border-border-subtle text-sm"
                    />
                  </div>
                  {forgotSentMsg && (
                    <p className="p-3 rounded-xl bg-surface-container-low border border-primary/20 text-xs text-on-surface">
                      {forgotSentMsg}
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full py-3 rounded-xl bg-primary-container text-white font-bold text-sm hover:bg-primary disabled:opacity-60"
                  >
                    {busy ? "Issuing instructions..." : "Send Reset Instructions"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubMode("login")}
                    className="text-xs font-bold text-primary hover:underline"
                  >
                    ← Back to Sign In
                  </button>
                </form>
              )}

              {subMode === "reset" && (
                <form onSubmit={handleResetSubmit} className="mt-6 space-y-4">
                  <div>
                    <label htmlFor="reset-token" className="block text-xs font-bold mb-1">
                      Reset Token
                    </label>
                    <input
                      id="reset-token"
                      type="text"
                      required
                      value={resetToken}
                      onChange={(e) => setResetToken(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-lg bg-paper-base border border-border-subtle text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label htmlFor="reset-new-pw" className="block text-xs font-bold mb-1">
                      New Password
                    </label>
                    <input
                      id="reset-new-pw"
                      type={showPassword ? "text" : "password"}
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="At least 8 chars with letter + number/symbol"
                      className="w-full px-3.5 py-2.5 rounded-lg bg-paper-base border border-border-subtle text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busy || !pwStrength.meetsMin}
                    className="w-full py-3 rounded-xl bg-primary-container text-white font-bold text-sm hover:bg-primary disabled:opacity-60"
                  >
                    {busy ? "Resetting..." : "Update Password"}
                  </button>
                </form>
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-border-subtle flex items-center justify-between text-xs text-on-surface-variant">
              <a href={routes.jobs} className="text-primary font-semibold hover:underline">
                Browse public jobs without signing in →
              </a>
              <span>
                {subMode === "login" ? (
                  <>
                    New here?{" "}
                    <a
                      href={routes.signup(returnTo || undefined)}
                      className="text-primary font-bold hover:underline"
                    >
                      Create account
                    </a>
                  </>
                ) : (
                  <>
                    Already have an account?{" "}
                    <a
                      href={routes.login(returnTo || undefined)}
                      className="text-primary font-bold hover:underline"
                    >
                      Sign in
                    </a>
                  </>
                )}
              </span>
            </div>
          </div>

          {/* Prototype Demo Quick-Access Panel */}
          <div className="lg:col-span-5 bg-surface-card rounded-2xl border border-border-subtle shadow-sm p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-primary">
                <Sparkles className="w-4 h-4" />
                <span>Prototype Demo Workspaces</span>
              </div>
              <p className="text-xs text-on-surface-variant mt-1.5 leading-relaxed">
                Explore seeded HireZilla workspaces immediately. Seeded data is clearly marked as Demo.
              </p>

              <div className="mt-4 space-y-2.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleDemoPreset("student_arjun")}
                  className="w-full text-left p-3.5 rounded-xl bg-paper-base border border-border-subtle hover:border-primary/40 transition-all"
                >
                  <p className="text-sm font-bold text-on-surface">
                    Arjun Mehta · Student / Candidate
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Public portfolio `/p/arjun-mehta`, applications &amp; AI interview
                  </p>
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleDemoPreset("recruiter_priya")}
                  className="w-full text-left p-3.5 rounded-xl bg-paper-base border border-border-subtle hover:border-primary/40 transition-all"
                >
                  <p className="text-sm font-bold text-on-surface">
                    Priya Sharma · Recruiter (CloudScale Labs)
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    8 applicants, referral-first ranking, exact tie review &amp; AI report
                  </p>
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleDemoPreset("recruiter_nimbus")}
                  className="w-full text-left p-3.5 rounded-xl bg-paper-base border border-border-subtle hover:border-primary/40 transition-all"
                >
                  <p className="text-sm font-bold text-on-surface">
                    Aravind Rao · Recruiter (Nimbus FinTech)
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Separate tenant workspace verifying company isolation
                  </p>
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleDemoPreset("admin")}
                  className="w-full text-left p-3.5 rounded-xl bg-surface-container-low border border-border-subtle hover:border-primary/40 transition-all"
                >
                  <p className="text-sm font-bold text-on-surface flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5 text-primary" />
                    <span>Pre-provisioned Admin · Trust &amp; Safety</span>
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Flags, moderation actions, audit log &amp; dev email outbox
                  </p>
                </button>
              </div>
            </div>

            <p className="text-[11px] text-outline mt-4 leading-snug">
              Note: Admin role is never selectable via public signup and requires server allowlist provisioning.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
