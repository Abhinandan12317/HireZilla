# Context must be the repo root. shared/ sits outside frontend/, so the build is docker build -f frontend/Dockerfile . and every COPY path starts from the root.
# Build stage must mirror the repo. ../shared is a relative import, so frontend/ and shared/ must be siblings (/app/frontend, /app/shared).
# npm start can't be the container command. It runs tsx, which is a devDependency and gets removed by --omit=dev. Compile server.ts instead.
# esbuild is a devDependency, so it exists only in the build stage. That's fine, because the compile happens there.
# express is a runtime dependency, so stage 2 needs npm ci --omit=dev.
# React and the other UI libraries are also in dependencies. They're only needed to build, so the runtime image carries them uselessly. Harmless for now, and a later optimization.
# .dockerignore with -f: BuildKit reads frontend/Dockerfile.dockerignore first, then the root .dockerignore. Don't ignore index.html files, because vite.config.ts finds every one under frontend/.
# VITE_API_BASE_URL is baked in at build time. Keep .env* ignored so it stays empty.
# Runtime values: BACKEND_URL=http://backend:4000 (inside a container, localhost is the container itself).
# Output location: Vite writes frontend/dist, and server.mjs expects dist/ next to it.

FROM node:22.14.0 AS build

WORKDIR /app/frontend

COPY frontend/package-lock.json frontend/package.json ./
RUN npm ci 
#Keeping the frontend and import architecture same, i am just cloning it and building in the similar world as of local
COPY frontend ./
COPY shared /app/shared
RUN npm run build
#A command that produces server.mjs
RUN npx esbuild server.ts --bundle --platform=node --format=esm --packages=external --outfile=server.mjs

FROM node:22.14.0

WORKDIR /app
#Again install dependencies
COPY frontend/package-lock.json frontend/package.json ./
RUN npm ci --omit=dev
#Copy the built files, and run the ammplication by exposing the required port. 
COPY --from=build /app/frontend/dist ./dist
COPY --from=build /app/frontend/server.mjs ./

EXPOSE 5173
CMD ["node","server.mjs"]
