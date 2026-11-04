# Internal runner: the only service that talks to the Docker daemon.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/lab-core/package.json packages/lab-core/
COPY apps/web/package.json apps/web/
COPY apps/control/package.json apps/control/
COPY apps/runner/package.json apps/runner/
RUN npm ci --omit=dev --workspace @devops-playground/runner --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY labs labs
COPY packages/lab-core/package.json packages/lab-core/
COPY packages/lab-core/src packages/lab-core/src
COPY apps/runner/package.json apps/runner/
# Express 5 is nested under the workspace because the root workload keeps Express 4.
COPY --from=deps /app/apps/runner/node_modules apps/runner/node_modules
COPY apps/runner/src apps/runner/src
USER node
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/v1/health', { headers: { authorization: 'Bearer ' + process.env.RUNNER_TOKEN } }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/runner/src/server.js"]
