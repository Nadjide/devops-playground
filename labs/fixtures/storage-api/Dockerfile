# Approved storage-capable lab fixture image. It has no dependencies, so the
# build needs only the base image. Storage settings are set by the runner.
FROM node:22-alpine
ARG APP_VERSION=1.0.0
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY package.json server.js storage.js ./
COPY tests ./tests
USER node
EXPOSE 3000
# The image healthcheck targets the lab's expected port 3000 from inside the container.
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
