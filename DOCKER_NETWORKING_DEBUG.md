# Docker Networking & Reverse Proxy Debugging Report

## 1. Issue Overview

### Symptom
When accessing the frontend web application in the browser at `http://localhost:5173`, authentication and API requests failed with HTTP `404 Not Found`.

**Observed Network Request:**
* **Request URL:** `http://localhost:5173/api/auth/me`
* **Request Method:** `GET`
* **Status Code:** `404 Not Found`
* **Remote Address:** `[::1]:5173`
* **Response Body:** `Page not found.`
* **Referrer Policy:** `strict-origin-when-cross-origin`

Both the frontend and backend containers were running simultaneously inside the same custom Docker bridge network (`hirezilla-net`), yet frontend API calls were not reaching the backend.

---

## 2. Architecture Context

The HireZilla architecture uses a reverse-proxy pattern for containerized deployment:

```
[ Browser / Client ]
        │
        │ HTTP Requests (e.g. GET /api/auth/me)
        ▼
[ Frontend Container: hirezilla-frontend ] (Port 5173)
        │
        ├─ Static Assets / HTML Pages (Served directly from /dist)
        │
        └─ Reverse Proxy (/api/*)
                │
                │ Docker Network: hirezilla-net (Internal DNS)
                ▼
   [ Backend Container: hirezilla-backend ] (Port 4000)
```

1. The client browser loads the UI from `http://localhost:5173`.
2. The frontend client code (`frontend/src/lib/api.ts`) issues relative requests (e.g., `/api/auth/me`).
3. The Node server inside the frontend container (`frontend/server.ts`, built as `server.mjs`) is responsible for serving static files **and** reverse-proxying all `/api/*` traffic upstream to the backend service.

---

## 3. Step-by-Step Diagnostic Backtracking

### Step 1: Trace the Target Port and URL
* **Target Address:** `http://localhost:5173`
* Port `5173` is bound to the **frontend** container, not the backend (the backend listens on port `4000`).
* **Inference:** Because the browser communicates with port `5173`, API communication failure means either:
  1. The frontend server is not receiving or routing `/api` traffic, or
  2. The frontend container cannot reach the backend container over Docker's network bridge.

### Step 2: Inspect Containers and Network Topology
Checking active containers:
```bash
docker ps
```
Output:
```
CONTAINER ID   IMAGE                   COMMAND                  PORTS                    NAMES
5453e49470e8   hirezilla-frontend:v1   "docker-entrypoint.s…"   0.0.0.0:5173->5173/tcp   hirezilla-frontend
ae561ccc635b   hirezilla-backend:v1    "docker-entrypoint.s…"   0.0.0.0:4000->4000/tcp   hirezilla-backend
```

Checking network attachments:
```bash
docker inspect hirezilla-frontend --format '{{json .NetworkSettings.Networks}}'
docker inspect hirezilla-backend --format '{{json .NetworkSettings.Networks}}'
```
* Network name: `hirezilla-net` (bridge driver)
* `hirezilla-backend` IP: `172.19.0.3`, DNS alias: `hirezilla-backend`
* `hirezilla-frontend` IP: `172.19.0.2`, DNS alias: `hirezilla-frontend`

### Step 3: Test Direct Inter-Container Connectivity
To determine whether Docker's internal DNS or bridge networking was the culprit, a direct HTTP request was executed from inside the `hirezilla-frontend` container to `hirezilla-backend`:

```bash
docker exec hirezilla-frontend node -e "fetch('http://hirezilla-backend:4000/api/auth/me').then(async r => { console.log('STATUS:', r.status); console.log(await r.text()); })"
```

Output:
```json
STATUS: 200
{"user":null,"company":null,"portfolio":null,"authConfig":{"googleClientId":"...","googleEnabled":true,"demoAuthEnabled":true,"passwordEnabled":true}}
```

**Key Finding:** 
The containers had healthy network communication over `hirezilla-net`. Docker DNS successfully resolved `hirezilla-backend:4000`, and the backend returned HTTP `200 OK`. The failure was isolated to the frontend container's request handling.

### Step 4: Examine the HTTP 404 Response
Curling the frontend container on port 5173:
```bash
curl -i http://localhost:5173/api/auth/me
```

Output:
```http
HTTP/1.1 404 Not Found
Content-Type: text/html; charset=utf-8
Content-Length: 15

Page not found.
```

Notice:
1. `Content-Type: text/html` (an API endpoint typically returns JSON).
2. The response body is `Page not found.`.

### Step 5: Code Inspection of `frontend/server.ts`
Reviewing how requests are routed in `frontend/server.ts`:
```typescript
const PORT = Number(process.env.PORT || 5173);
const DIST_DIR = path.resolve(__dirname, "dist");
const BACKEND_URL = (process.env.BACKEND_URL || "").replace(/\/+$/, "");

function main() {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "hirezilla-frontend",
      mode: "mpa",
      backendProxyConfigured: Boolean(BACKEND_URL),
    });
  });

  if (BACKEND_URL) {
    app.use("/api", createApiReverseProxy(BACKEND_URL));
  }

  app.use(express.static(DIST_DIR, { index: false }));

  // Non-SPA Multi-Page HTML Resolution (catch-all route)
  app.get("*", (req, res) => {
    const mappedHtml = resolveMpaHtmlPath(req.path);
    if (!mappedHtml) {
      res.status(404).send("Page not found.");
      return;
    }
    ...
  });
}
```

And in `shared/mpaRoutes.ts`:
```typescript
export function resolveMpaHtmlPath(rawPathname: string): string | null {
  const pathname = (rawPathname || "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    ...
  ) {
    return null;
  }
  ...
}
```

**Mechanism of the 404:**
1. If `BACKEND_URL` is empty or missing, `if (BACKEND_URL)` evaluates to `false`.
2. The reverse proxy route `app.use("/api", createApiReverseProxy(BACKEND_URL))` is **never registered**.
3. Incoming requests to `/api/auth/me` skip past static file serving and reach `app.get("*")`.
4. `resolveMpaHtmlPath("/api/auth/me")` returns `null` because `/api/` is not a web page.
5. The handler responds with `res.status(404).send("Page not found.")`.

### Step 6: Verify Container Runtime Environment
Querying the frontend container's `/health` endpoint:
```bash
curl http://localhost:5173/health
```
Output:
```json
{"status":"ok","service":"hirezilla-frontend","mode":"mpa","backendProxyConfigured":false}
```

Checking container environment variables:
```bash
docker inspect hirezilla-frontend --format '{{json .Config.Env}}'
```
Output:
```json
["PORT=5173", "PATH=...", "NODE_VERSION=22.14.0", "YARN_VERSION=1.22.22"]
```

Frontend container logs:
```
{"level":"info","event":"hirezilla_frontend_mpa_started","port":5173,"distDir":"/dist","backendProxyTarget":null}
```

`BACKEND_URL` was completely omitted when launching the container.

---

## 4. Key Takeaways & Docker Pitfalls

1. **Host `localhost` vs Container `localhost`:**
   * Inside the browser on the host machine, `localhost:4000` accesses the backend.
   * **Inside the frontend container**, `localhost` refers to its own local network interface (`127.0.0.1`), where no backend is running.
   * Inter-container communication within Docker must use the container name (e.g. `http://hirezilla-backend:4000`).

2. **Conditional Route Registration:**
   * When application servers conditionally bind routes based on environment variables, missing variables can cause API calls to silently fall through to catch-all 404 handlers.

---

## 5. Resolution & Verification

### Fix Command
Stop the existing frontend container and launch it with `BACKEND_URL` configured to the backend container's DNS name:

```powershell
# Stop and remove the existing frontend container
docker stop hirezilla-frontend

# Run with BACKEND_URL pointing to the backend container
docker run -d `
  --name hirezilla-frontend `
  --network hirezilla-net `
  -p 5173:5173 `
  -e BACKEND_URL=http://hirezilla-backend:4000 `
  hirezilla-frontend:v1
```

### Verification Results

1. **Frontend Health Status:**
   ```bash
   curl http://localhost:5173/health
   ```
   ```json
   {"status":"ok","service":"hirezilla-frontend","mode":"mpa","backendProxyConfigured":true}
   ```

2. **API Proxying on Port 5173:**
   ```bash
   curl -i http://localhost:5173/api/auth/me
   ```
   ```http
   HTTP/1.1 200 OK
   x-content-type-options: nosniff
   referrer-policy: strict-origin-when-cross-origin
   access-control-allow-credentials: true
   content-type: application/json; charset=utf-8

   {"user":null,"company":null,"portfolio":null,"authConfig":{"googleClientId":"...","googleEnabled":true,"demoAuthEnabled":true,"passwordEnabled":true}}
   ```

Frontend-to-backend communication is fully restored and operating as expected.
