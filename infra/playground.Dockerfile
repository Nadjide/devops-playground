# Workbench control portal: static workbench build plus the management API.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/lab-core/package.json packages/lab-core/
COPY apps/web/package.json apps/web/
COPY apps/control/package.json apps/control/
COPY apps/runner/package.json apps/runner/
RUN npm ci --workspace @devops-playground/web --no-audit --no-fund
COPY labs labs
COPY packages/lab-core packages/lab-core
COPY apps/web apps/web
RUN npm run build --workspace @devops-playground/web

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/lab-core/package.json packages/lab-core/
COPY apps/web/package.json apps/web/
COPY apps/control/package.json apps/control/
COPY apps/runner/package.json apps/runner/
RUN npm ci --omit=dev --workspace @devops-playground/control --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY labs labs
COPY packages/lab-core/package.json packages/lab-core/
COPY packages/lab-core/src packages/lab-core/src
COPY apps/control/package.json apps/control/
# Express 5 is nested under the workspace because the root workload keeps Express 4.
COPY --from=deps /app/apps/control/node_modules apps/control/node_modules
COPY apps/control/src apps/control/src
COPY --from=build /src/apps/web/dist apps/web/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/control/src/server.js"]
