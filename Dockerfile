# syntax=docker/dockerfile:1

# --- Build: compile TypeScript, then drop dev dependencies -------------------
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- Runtime: compiled code and production dependencies only -----------------
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    AUDIT_LOG_PATH=/app/data/audit-log.json

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# The audit file lives in a volume owned by the unprivileged user.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# ENCRYPTION_KEY is not set here on purpose: it is supplied when the
# container starts and the server exits if it is missing.
CMD ["node", "dist/server.js"]
