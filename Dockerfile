FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile \
    && node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(":memory:"); db.exec("SELECT 1"); db.close();'
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production HOST=127.0.0.1 PORT=3000 DATA_DIR=/app/data
CMD ["node", "dist-server/server/index.js"]
