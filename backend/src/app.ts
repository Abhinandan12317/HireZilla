import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config";
import { attachRequestId, hydrateAuthUser } from "./middleware/auth";
import { adminRouter } from "./routes/admin";
import { applicationsRouter } from "./routes/applications";
import { authRouter } from "./routes/auth";
import { companiesRouter } from "./routes/companies";
import { dashboardRouter } from "./routes/dashboard";
import { interviewsRouter } from "./routes/interviews";
import { jobsRouter } from "./routes/jobs";
import { portfoliosRouter } from "./routes/portfolios";
import { logEvent } from "./services/audit";
import { getGeminiHealthReport } from "./services/aiHealth";

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // curl, server-to-server, Supertest, health checks
  const normalized = origin.replace(/\/+$/, "");
  if (config.corsOrigins.includes("*")) return true;
  if (config.corsOrigins.includes(normalized)) return true;
  if (normalized === config.frontendUrl || normalized === config.appUrl) return true;
  if (
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized) &&
    config.nodeEnv !== "production"
  ) {
    return true;
  }
  return false;
}

function isSameRequestHost(origin: string, req: Request): boolean {
  try {
    const parsedOrigin = new URL(origin);
    const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)
      ?.split(",")[0]
      ?.trim();
    const hostHeader = forwardedHost || req.headers.host;
    return Boolean(hostHeader && parsedOrigin.host === hostHeader);
  } catch {
    return false;
  }
}

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.use(attachRequestId);
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS origin blocked: ${origin}`));
        }
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Request-Id",
        "X-Requested-With",
        "X-Interview-Session-Nonce",
      ],
    })
  );
  app.use(cookieParser());

  // Enforce Origin/Referer CSRF check on cookie-authenticated state-changing requests
  app.use((req, res, next) => {
    const mutatingMethod =
      req.method === "POST" ||
      req.method === "PUT" ||
      req.method === "PATCH" ||
      req.method === "DELETE";
    const hasCookieSession = Boolean(req.cookies?.hz_session);
    const hasBearerAuth =
      typeof req.headers.authorization === "string" &&
      /^Bearer\s+/i.test(req.headers.authorization);

    if (mutatingMethod && hasCookieSession && !hasBearerAuth) {
      const originHeader =
        typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      let sourceOrigin = originHeader;
      if (!sourceOrigin && typeof req.headers.referer === "string") {
        try {
          sourceOrigin = new URL(req.headers.referer).origin;
        } catch {
          res.status(403).json({ error: "Invalid request referer origin." });
          return;
        }
      }
      if (
        sourceOrigin &&
        !isOriginAllowed(sourceOrigin) &&
        !isSameRequestHost(sourceOrigin, req)
      ) {
        res.status(403).json({ error: "Cross-site state-changing request blocked." });
        return;
      }
    }
    next();
  });

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(hydrateAuthUser);

  app.get("/api/health", (_req, res) => {
    const aiHealth = getGeminiHealthReport();
    res.json({
      status: "ok",
      service: "hirezilla-backend",
      product: "HireZilla",
      geminiConfigured: Boolean(config.geminiApiKey),
      googleOAuthConfigured: Boolean(config.googleClientId),
      dbMode: config.mongodbUri ? "mongodb" : config.isTest ? "memory" : "local_file",
      ai: {
        status: aiHealth.status,
        configured: aiHealth.configured,
        canRunAiInterviews: aiHealth.canRunAiInterviews,
        model: aiHealth.model,
        checkedAt: aiHealth.checkedAt,
      },
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api", dashboardRouter);
  app.use("/api", companiesRouter);
  app.use("/api", portfoliosRouter);
  app.use("/api", jobsRouter);
  app.use("/api", applicationsRouter);
  app.use("/api", interviewsRouter);
  app.use("/api", adminRouter);

  app.use("/api/*", (_req, res) => {
    res.status(404).json({ error: "API route not found." });
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logEvent("error", "unhandled_api_error", {
      message: err.message,
      requestId: req.requestId,
    });
    if (res.headersSent) return;
    const status = err.message.startsWith("CORS origin blocked:") ? 403 : 500;
    res.status(status).json({
      error: status === 403 ? err.message : "An unexpected server error occurred.",
      requestId: req.requestId,
    });
  });

  return app;
}
