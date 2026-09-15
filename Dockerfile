FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/pnpm/corepack
ENV PATH=$PNPM_HOME:$PATH
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ARG API_INTERNAL_URL=http://api:3101
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3101
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/.cache/models && chown -R node:node /app/.cache
USER node
EXPOSE 3100 3101
CMD ["pnpm", "start:api"]
