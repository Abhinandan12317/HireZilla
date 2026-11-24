import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { AuthUser, Company, StudentPortfolio } from "../../../shared/types";
import { apiRequest, setStoredAuthToken } from "../lib/api";

interface AuthConfig {
  googleClientId: string | null;
  googleEnabled: boolean;
  demoAuthEnabled: boolean;
  passwordEnabled: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  company: Company | null;
  portfolio: StudentPortfolio | null;
  authConfig: AuthConfig;
  loading: boolean;
  refreshMe: () => Promise<void>;
  demoSignIn: (
    preset: "student_arjun" | "recruiter_priya" | "recruiter_nimbus" | "admin"
  ) => Promise<{ user: AuthUser; needsRoleSelection: boolean }>;
  registerWithPassword: (params: {
    email: string;
    name: string;
    password: string;
  }) => Promise<{ user: AuthUser; needsRoleSelection: boolean }>;
  loginWithPassword: (params: {
    email: string;
    password: string;
  }) => Promise<{ user: AuthUser; needsRoleSelection: boolean }>;
  setupPassword: (params: {
    currentPassword?: string;
    newPassword: string;
  }) => Promise<AuthUser>;
  forgotPassword: (email: string) => Promise<{ ok: boolean; message: string }>;
  resetPassword: (params: {
    token: string;
    newPassword: string;
  }) => Promise<{ ok: boolean; message: string }>;
  emailSignUp: (
    email: string,
    name?: string
  ) => Promise<{ user: AuthUser; needsRoleSelection: boolean }>;
  googleSignIn: (idToken: string) => Promise<{ user: AuthUser; needsRoleSelection: boolean }>;
  selectRole: (role: "student" | "recruiter") => Promise<AuthUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [portfolio, setPortfolio] = useState<StudentPortfolio | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig>({
    googleClientId: null,
    googleEnabled: false,
    demoAuthEnabled: true,
    passwordEnabled: true,
  });
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    try {
      const res = await apiRequest<{
        user: AuthUser | null;
        company: Company | null;
        portfolio: StudentPortfolio | null;
        authConfig: AuthConfig;
      }>("/api/auth/me");
      setUser(res.user);
      setCompany(res.company);
      setPortfolio(res.portfolio);
      setAuthConfig({
        ...res.authConfig,
        passwordEnabled: res.authConfig.passwordEnabled ?? true,
      });
    } catch {
      setUser(null);
      setCompany(null);
      setPortfolio(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  const demoSignIn = async (
    preset: "student_arjun" | "recruiter_priya" | "recruiter_nimbus" | "admin"
  ) => {
    const res = await apiRequest<{
      user: AuthUser;
      token?: string;
      needsRoleSelection: boolean;
    }>("/api/auth/demo-signin", {
      method: "POST",
      body: JSON.stringify({ preset }),
    });
    if (res.token) setStoredAuthToken(res.token);
    await refreshMe();
    return res;
  };

  const registerWithPassword = async (params: {
    email: string;
    name: string;
    password: string;
  }) => {
    const res = await apiRequest<{
      user: AuthUser;
      token?: string;
      needsRoleSelection: boolean;
    }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: params.email.trim(),
        name: params.name.trim(),
        password: params.password,
      }),
    });
    if (res.token) setStoredAuthToken(res.token);
    await refreshMe();
    return res;
  };

  const loginWithPassword = async (params: { email: string; password: string }) => {
    const res = await apiRequest<{
      user: AuthUser;
      token?: string;
      needsRoleSelection: boolean;
    }>("/api/auth/login-password", {
      method: "POST",
      body: JSON.stringify({
        email: params.email.trim(),
        password: params.password,
      }),
    });
    if (res.token) setStoredAuthToken(res.token);
    await refreshMe();
    return res;
  };

  const setupPassword = async (params: {
    currentPassword?: string;
    newPassword: string;
  }) => {
    const res = await apiRequest<{ ok: boolean; user: AuthUser; token?: string }>(
      "/api/auth/password/setup",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );
    if (res.token) setStoredAuthToken(res.token);
    await refreshMe();
    return res.user;
  };

  const forgotPassword = async (email: string) => {
    return apiRequest<{ ok: boolean; message: string }>("/api/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify({ email: email.trim() }),
    });
  };

  const resetPassword = async (params: { token: string; newPassword: string }) => {
    return apiRequest<{ ok: boolean; message: string }>("/api/auth/password/reset", {
      method: "POST",
      body: JSON.stringify(params),
    });
  };

  const emailSignUp = async (email: string, name?: string) => {
    const cleanEmail = email.trim();
    const cleanName = name?.trim();
    const body: { email: string; name?: string } = { email: cleanEmail };
    if (cleanName) {
      body.name = cleanName;
    }
    const res = await apiRequest<{
      user: AuthUser;
      token?: string;
      needsRoleSelection: boolean;
    }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.token) setStoredAuthToken(res.token);
    await refreshMe();
    return res;
  };

  const googleSignIn = async (idToken: string) => {
    const res = await apiRequest<{
      user: AuthUser;
      token?: string;
      needsRoleSelection: boolean;
    }>("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ idToken }),
    });
    if (res.token) setStoredAuthToken(res.token);
    await refreshMe();
    return res;
  };

  const selectRole = async (role: "student" | "recruiter") => {
    const res = await apiRequest<{ user: AuthUser; token?: string }>("/api/auth/role", {
      method: "POST",
      body: JSON.stringify({ role }),
    });
    if (res.token) setStoredAuthToken(res.token);
    await refreshMe();
    return res.user;
  };

  const logout = async () => {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } finally {
      setStoredAuthToken(null);
      setUser(null);
      setCompany(null);
      setPortfolio(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        company,
        portfolio,
        authConfig,
        loading,
        refreshMe,
        demoSignIn,
        registerWithPassword,
        loginWithPassword,
        setupPassword,
        forgotPassword,
        resetPassword,
        emailSignUp,
        googleSignIn,
        selectRole,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
