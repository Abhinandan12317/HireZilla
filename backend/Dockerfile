# Context must be the repo root: docker build -f backend/Dockerfile -t hirezilla-backend .
# ---- Stage 1: build ----
FROM node:22.14.0 AS build
WORKDIR /app/backend

# Dependencies first
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

# Copy backend source and shared directory preserving relative import hierarchy (../../../shared)
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY shared /app/shared

RUN npm run build

# ---- Stage 2: runtime ----
FROM node:22.14.0 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output from build stage
COPY --from=build /app/backend/dist ./dist

EXPOSE 4000

CMD ["node", "dist/server.mjs"]
