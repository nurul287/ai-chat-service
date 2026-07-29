# syntax=docker/dockerfile:1
#
# Deliberately a Dockerfile rather than Nixpacks. Nixpacks infers the toolchain,
# and its inferences broke this build twice:
#
#   1. With no `packageManager` field it guessed pnpm 9, which cannot read a
#      pnpm 11 lockfile.
#   2. With `packageManager` set it enabled Corepack — but pins corepack@0.24.1,
#      which is too old to load pnpm 11's entrypoint and dies with
#      ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.
#
# Pinning pnpm explicitly here makes the build identical on a laptop, in CI and
# on Railway, and lets it be verified with `docker build` before deploying.

ARG NODE_IMAGE=node:22-slim
ARG PNPM_VERSION=11.17.0

# ---- dependencies (including dev, needed to compile) ------------------------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION}
# pnpm-workspace.yaml carries the allowBuilds approval for esbuild; without it
# pnpm 11 aborts with ERR_PNPM_IGNORED_BUILDS.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- compile ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---- production dependencies only -------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
ARG PNPM_VERSION
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Run as the image's existing unprivileged user rather than root.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
# Documentation only — Railway injects PORT and the server reads it.
EXPOSE 4000
CMD ["node", "dist/server.js"]
