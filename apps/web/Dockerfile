# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG NEXT_PUBLIC_SHADOW_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_SHADOW_API_URL=$NEXT_PUBLIC_SHADOW_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc turbo.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/api/package.json ./apps/api/package.json
COPY examples ./examples
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @shadow/web build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN addgroup -S shadow && adduser -S shadow -G shadow
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER shadow
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
