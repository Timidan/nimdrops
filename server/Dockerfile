# NimDrops runtime image — one image, two entrypoints.
#
# `server` (src/index.ts) and `worker` (src/worker.ts) run the SAME image with
# different commands. That is deliberate: they share every service module, and a
# version skew between the HTTP layer and the process that signs transactions is
# exactly the kind of drift that turns a restart into a double payment.
#
# TypeScript is executed directly with `tsx` rather than compiled. The build step
# is one less thing that can differ between `pnpm vitest` and production, and the
# money path is proven by tests against the same sources this image runs.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- stage 1: the SPA -------------------------------------------------------------
#
# `web/dist` is gitignored, so the image builds it. The server serves the result
# from one origin (design §4.1) — there is no separate static host and no CORS on
# the money path.

FROM base AS web-build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter web...
COPY web web
RUN pnpm --filter web build

# ---- stage 2: runtime ---------------------------------------------------------------

FROM base AS runtime
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/package.json
# Dev dependencies are kept: `tsx` is the runtime. `--frozen-lockfile` makes an
# out-of-date lockfile a build failure rather than a silent version drift.
RUN pnpm install --frozen-lockfile --filter @nimdrops/server...
COPY server server
COPY --from=web-build /app/web/dist /app/web/dist

ENV NODE_ENV=production
# Not read by the app; documents where `registerSsr` looks by default
# (`<repo>/web/dist`, resolved relative to server/src/http/ssr.ts).
ENV SPA_DIST=/app/web/dist

WORKDIR /app/server
USER node
EXPOSE 8080
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
