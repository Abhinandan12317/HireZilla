export const routes = {
  home: "/",
  jobs: "/jobs",
  jobDetail: (jobId: string) => `/jobs/${encodeURIComponent(jobId)}`,
  easyApply: (jobId: string) => `/jobs/${encodeURIComponent(jobId)}/apply`,
  packages: "/packages",
  login: (returnTo?: string) =>
    returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login",
  signup: (returnTo?: string) =>
    returnTo ? `/signup?returnTo=${encodeURIComponent(returnTo)}` : "/signup",
  forgotPassword: "/login?mode=forgot",
  accountSecurity: "/login?mode=security",
  portfolio: (slug: string) => `/p/${encodeURIComponent(slug)}`,
  interview: (token: string) => `/interview/${encodeURIComponent(token)}`,
  interviewById: (interviewId: string) => `/interview?id=${encodeURIComponent(interviewId)}`,
  studentDashboard: "/student/dashboard",
  studentOnboarding: (returnTo?: string) =>
    returnTo
      ? `/student/onboarding?returnTo=${encodeURIComponent(returnTo)}`
      : "/student/onboarding",
  studentApplications: "/student/applications",
  studentApplicationDetail: (applicationId: string) =>
    `/student/applications/${encodeURIComponent(applicationId)}`,
  recruiterDashboard: "/recruiter/dashboard",
  recruiterCompany: "/recruiter/company",
  recruiterPackage: "/recruiter/package",
  recruiterJobs: "/recruiter/jobs",
  recruiterJobNew: "/recruiter/jobs/new",
  recruiterJobEdit: (jobId: string) => `/recruiter/jobs/${encodeURIComponent(jobId)}/edit`,
  recruiterJobApplicants: (jobId: string) =>
    `/recruiter/jobs/${encodeURIComponent(jobId)}/applicants`,
  recruiterTieReview: (jobId: string, tieGroupKey: string) =>
    `/recruiter/jobs/${encodeURIComponent(jobId)}/ties/${encodeURIComponent(tieGroupKey)}`,
  recruiterInterviewSetup: (jobId: string) =>
    `/recruiter/jobs/${encodeURIComponent(jobId)}/interview-setup`,
  recruiterInterviews: (jobId: string) =>
    `/recruiter/jobs/${encodeURIComponent(jobId)}/interviews`,
  recruiterCandidateDossier: (applicationId: string) =>
    `/recruiter/applications/${encodeURIComponent(applicationId)}`,
  recruiterInterviewReport: (applicationId: string) =>
    `/recruiter/applications/${encodeURIComponent(applicationId)}/interview-report`,
  admin: (tab?: string) => (tab ? `/admin?tab=${encodeURIComponent(tab)}` : "/admin"),
} as const;

export function navigateTo(url: string): void {
  window.location.assign(url);
}

export function replaceWith(url: string): void {
  window.location.replace(url);
}

export function getQueryParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

export function setQueryParam(key: string, value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  window.history.replaceState({}, "", url.toString());
}

export function getRouteParam(queryKey: string, pathRegex: RegExp, groupIndex = 1): string | undefined {
  const fromQuery = getQueryParam(queryKey);
  if (fromQuery) return decodeURIComponent(fromQuery);
  const cleanPath = window.location.pathname.replace(/\/+$/, "") || "/";
  const match = cleanPath.match(pathRegex);
  if (match && match[groupIndex]) {
    const val = decodeURIComponent(match[groupIndex]);
    if (val !== "detail" && val !== "apply" && val !== "index.html") {
      return val;
    }
  }
  return undefined;
}

export function isActivePath(targetPath: string, exact = false): boolean {
  const cur = (window.location.pathname.replace(/\/+$/, "") || "/") + window.location.search;
  const curPath = window.location.pathname.replace(/\/+$/, "") || "/";
  if (targetPath.includes("?")) {
    return cur === targetPath || (targetPath === "/admin" && cur === "/admin");
  }
  const normalizedTarget = targetPath.replace(/\/+$/, "") || "/";
  if (exact) return curPath === normalizedTarget;
  return curPath === normalizedTarget || curPath.startsWith(`${normalizedTarget}/`);
}

export function sanitizeReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
    return null;
  }
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

export function safeExternalUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}
