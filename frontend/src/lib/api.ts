const RAW_API_BASE = (import.meta.env?.VITE_API_BASE_URL as string | undefined) || "";
export const API_BASE_URL = RAW_API_BASE.replace(/\/+$/, "");

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${cleanPath}` : cleanPath;
}

export function getStoredAuthToken(): string | null {
  return null;
}

export function setStoredAuthToken(_token: string | null | undefined): void {
  // Sessions use HttpOnly cookies (SameSite=None; Partitioned when cross-origin HTTPS)
  // so tokens are never stored in browser Web Storage.
}

export class ApiError extends Error {
  status: number;
  code?: string;
  data?: unknown;

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const headers: Record<string, string> = {
    "X-Requested-With": "HireZilla",
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers as Record<string, string> | undefined),
  };

  const res = await fetch(apiUrl(path), {
    credentials: "include",
    ...options,
    headers,
  });

  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await res.json().catch(() => ({}))
    : await res.text().catch(() => "");

  if (!res.ok) {
    const errObj = typeof body === "object" && body ? (body as Record<string, unknown>) : {};
    const msg =
      (typeof errObj.error === "string" && errObj.error) ||
      (typeof body === "string" && body) ||
      `Request failed (${res.status})`;
    throw new ApiError(
      msg,
      res.status,
      typeof errObj.code === "string" ? errObj.code : undefined,
      errObj
    );
  }

  return body as T;
}
