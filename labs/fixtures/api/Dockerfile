# Approved lab fixture image. Build arguments come only from the runner's
# approved release catalog; browsers never supply them.
FROM node:22-alpine
ARG APP_VERSION=1.0.0
ARG STARTUP_MODE=ok
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    STARTUP_MODE=${STARTUP_MODE}
WORKDIR /app
COPY package.json server.js ./
COPY tests ./tests
USER node
EXPOSE 3000
# The image healthcheck targets the lab's expected port 3000 from inside the container.
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
