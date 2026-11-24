# Security Summary

**Reviewed Files**: 23
**Issues Resolved**: 9

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Admin Login Privilege Escalation | `backend/src/routes/auth.ts` | 135 | Unverified email signup/login allowed signing into or provisioning `admin` accounts without Google ID token verification or demo credentials. | High | Fixed | Rejected unverified email `/signup`, `/signin`, and `/login` requests targeting admin accounts or `ADMIN_BOOTSTRAP_EMAILS` with HTTP 403, and removed admin provisioning from unverified email signup. |
| Returning User Login Failure & Error Masking | `backend/src/routes/auth.ts`, `frontend/src/context/AuthContext.tsx`, `frontend/src/pages/AuthPage.tsx` | 109, 84, 95 | Login submitted `name: ""` which failed `.min(2)` and returned a masked `"Please provide a valid email address."` error. | High | Fixed | Normalized empty/whitespace `name` strings with `z.preprocess`, omitted empty names on the client, exposed specific Zod issue messages, and added `/signin` and `/login` route aliases. |
| Path Traversal Prefix Collision | `backend/src/services/pdfProcessor.ts` | 186 | `readPrivateResumeFile` used `startsWith(baseDir)` without a trailing directory separator, allowing sibling directory prefix collisions. | High | Fixed | Added null-byte rejection and enforced `safePath.startsWith(baseDir + path.sep)`. |
| Cross-Site Request Forgery (CSRF) & Header Hardening | `backend/src/app.ts` | 48 | Cookie-authenticated mutations relied solely on CORS headers without verifying `Origin`/`Referer` on non-CORS form submissions or disabling `x-powered-by`. | High | Fixed | Added `Origin`/`Referer` validation for cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` routes, disabled `x-powered-by`, and added `X-Content-Type-Options: nosniff` and `Referrer-Policy`. |
| Session Token in Browser Web Storage | `frontend/src/lib/api.ts`, `backend/src/middleware/auth.ts` | 12, 52 | Session JWTs were persisted to `window.sessionStorage`, exposing tokens to any script running in the page context. | Medium | Fixed | Removed Web Storage token persistence in favor of `HttpOnly` cookies (with `SameSite=None; Secure; Partitioned` for cross-origin HTTPS deployments) and `X-Requested-With` headers. |
| Open Redirect via `returnTo` | `frontend/src/lib/navigation.ts`, `frontend/src/pages/AuthPage.tsx`, `frontend/src/pages/StudentPortfolioBuilder.tsx` | 85, 27, 27 | `returnTo.startsWith("/")` permitted protocol-relative redirects such as `//evil.com`. | Medium | Fixed | Added `sanitizeReturnTo` to block `//`, `/\`, newline injection, and non-relative URLs before navigation. |
| Unsafe URL Schemes (`javascript:` / `data:`) | `backend/src/routes/portfolios.ts`, `backend/src/routes/companies.ts`, `frontend/src/pages/PublicPortfolioPage.tsx` | 18, 29, 117 | Zod `.url()` accepted `javascript:` and `data:` URIs which rendered directly into `<a>` `href` attributes. | High | Fixed | Enforced `http:`/`https:` protocol checks in backend Zod schemas and wrapped external `href` links in `safeExternalUrl` with `rel="noopener noreferrer"`. |
| Silent Production Database Fallback | `backend/src/db/database.ts` | 294 | Failed MongoDB Atlas connections in production silently degraded to unencrypted local JSON file storage (`hirezilla-db.json`). | High | Fixed | Configured `connectDatabase` to fail closed in `NODE_ENV=production` unless `ALLOW_LOCAL_DB_FALLBACK=true` is explicitly set. |
| Unbounded Input & Expired Interview Submit | `backend/src/routes/admin.ts`, `backend/src/routes/interviews.ts` | 133, 74, 652 | Admin `nextStatus` accepted arbitrary strings, AI question `count` was unbounded, and `/submit` lacked a deadline expiration check. | Medium | Fixed | Added strict per-target status enums in `admin.ts`, clamped question counts (`3..8`), checked `deadlineAt` (`410 Gone`), and bounded submitted answer payloads to valid question IDs. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| API Keys & Secrets | `backend/src/config.ts`, `.env.example` | `GEMINI_API_KEY`, `MONGODB_URI`, `SESSION_SECRET`, and `SIGNED_URL_SECRET` stay strictly server-side with placeholder values in `.env.example` and zero hardcoded credentials. |
| Authentication & Role Isolation | `backend/src/middleware/auth.ts`, `backend/src/routes/auth.ts` | `requireAuth`, `requireRole`, `assertCompanyAccess`, and `assertCandidateAccess` enforce server-side session and tenant boundaries on every protected endpoint. |
| PDF Upload Security | `backend/src/services/pdfProcessor.ts`, `backend/src/routes/applications.ts` | Validates `%PDF-` magic bytes, enforces size/page limits, confines private files, and serves downloads only via short-lived HMAC-signed tokens. |
| Dependencies | `package.json`, `bun.lock` | `bun audit` checked 347 packages and reported zero known vulnerabilities. |

---

## PoC Verification

### 1. Unverified Admin Login Escalation Blocked

#### Summary
| Field | Value |
|---|---|
| Issue Type | Privilege Escalation via Unverified Email Sign-In |
| Impact | High |
| Affected File | `backend/src/routes/auth.ts:135` |
| Test Scenario | `POST /api/auth/login` with `{ "email": "admin@hirezilla.local" }` |

#### How It Was Fixed
Added an explicit server-side check blocking unverified `/signup`, `/signin`, and `/login` requests whenever the target account has `role === "admin"` or appears in `ADMIN_BOOTSTRAP_EMAILS`, requiring Google OAuth ID token verification (`/api/auth/google`) or explicit demo preset sign-in.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Request enters `POST /api/auth/login` (`backend/src/routes/auth.ts:109`) | Email normalized to `admin@hirezilla.local` |
| 2 | Database lookup matches `usr_admin_root` with `role === "admin"` (`backend/src/routes/auth.ts:136`) | Admin role detected |
| 3 | Guard returns HTTP `403` without issuing cookie or JWT | **Blocked Safely** |

#### Conclusion
**Fix Verified** — Unverified email authentication endpoints can never mint or access admin sessions.

---

### 2. Returning User Email Login With Empty Name & Granular Validation Errors

#### Summary
| Field | Value |
|---|---|
| Issue Type | Authentication Denial & Masked Validation Errors |
| Impact | High |
| Affected File | `backend/src/routes/auth.ts:110`, `frontend/src/context/AuthContext.tsx:84`, `frontend/src/pages/AuthPage.tsx:95` |
| Test Scenario | `POST /api/auth/signup` with `{ "email": "returning_candidate@example.com", "name": "" }` and `{ "email": "valid@example.com", "name": "A" }` |

#### How It Was Fixed
Preprocessed empty/whitespace `name` values to `undefined` on the backend, omitted empty `name` values on the frontend, returned the exact failing Zod issue message, and added `/login` and `/signin` aliases.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Login form calls `emailSignUp(email, undefined)` (`AuthPage.tsx:96`) | Request omits empty `name` |
| 2 | Even if `{ name: "" }` is sent directly, `z.preprocess` converts `""` to `undefined` (`auth.ts:113`) | Name validation passes; existing user session issued (`200 OK`) |
| 3 | Invalid short name `"A"` returns `parsed.error.issues[0].message` (`auth.ts:128`) | Returns `"Name must be at least 2 characters."` (`400`) |

#### Conclusion
**Fix Verified** — Returning users sign back in seamlessly while invalid inputs report accurate field-level messages.

---

### 3. Path Traversal Sibling-Directory Prefix Collision

#### Summary
| Field | Value |
|---|---|
| Issue Type | Path Traversal Confinement Bypass |
| Impact | High |
| Affected File | `backend/src/services/pdfProcessor.ts:186` |
| Test Scenario | `readPrivateResumeFile("../private_storage_evil/secret.pdf")` and `"../../package.json"` |

#### How It Was Fixed
Normalized `baseDir = path.resolve(config.privateStorageDir)` and required `safePath.startsWith(baseDir + path.sep)` along with null-byte rejection.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Input enters `readPrivateResumeFile(storageKey)` (`pdfProcessor.ts:186`) | Null-byte check passes |
| 2 | `path.resolve(baseDir, storageKey)` resolves to `<root>/private_storage_evil/secret.pdf` | Resolved outside `baseDir/` |
| 3 | `!safePath.startsWith(baseDir + path.sep)` evaluates true (`pdfProcessor.ts:190`) | Returns `null` (**Blocked Safely**) |

#### Conclusion
**Fix Verified** — Only files strictly nested inside the private storage directory can be read.

---

### 4. `javascript:` URI Blocking & Open-Redirect Sanitization

#### Summary
| Field | Value |
|---|---|
| Issue Type | Unsafe Link Rendering (`javascript:`) & Protocol-Relative Redirect (`//evil.com`) |
| Impact | High |
| Affected File | `backend/src/routes/portfolios.ts:18`, `frontend/src/lib/navigation.ts:85`, `frontend/src/pages/PublicPortfolioPage.tsx:117` |
| Test Scenario | `PUT /api/portfolios/me` with `links.github = "javascript:alert(1)"` and `?returnTo=//evil.com/phish` |

#### How It Was Fixed
Added `httpUrlSchema` in backend schemas, `safeExternalUrl` for frontend `<a>` tags, and `sanitizeReturnTo` for post-auth redirects.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `PUT /api/portfolios/me` validates `links.github` via `httpUrlSchema` (`portfolios.ts:18`) | Protocol `"javascript:"` fails refine -> HTTP `400` |
| 2 | Even on legacy stored data, `safeExternalUrl` returns `undefined` (`PublicPortfolioPage.tsx:117`) | Anchor is omitted from DOM |
| 3 | `?returnTo=//evil.com/phish` passes into `sanitizeReturnTo` (`AuthPage.tsx:27`) | `startsWith("//")` returns `null` (**Blocked Safely**) |

#### Conclusion
**Fix Verified** — Dangerous URL schemes and off-site redirects are rejected at both API and UI boundaries.
