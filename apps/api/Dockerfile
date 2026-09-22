# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
# Pin the same pnpm as package.json's packageManager without corepack (deprecated in Node 25).
RUN npm install --global pnpm@10.34.5
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY examples ./examples
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @shadow/api build
RUN pnpm --filter @shadow/api --prod deploy /out --legacy

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S shadowapp && adduser -S shadowapp -G shadowapp
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
COPY --from=build /repo/apps/api/package.json ./package.json
USER shadowapp
EXPOSE 4000
CMD ["node", "dist/main.js"]
