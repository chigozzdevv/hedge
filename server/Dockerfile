FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
COPY packages/bindings/package.json packages/bindings/
COPY packages/sdk/package.json packages/sdk/
COPY packages/frontend/package.json packages/frontend/
COPY packages/nextjs/package.json packages/nextjs/
COPY packages/foundry/package.json packages/foundry/
COPY server/package.json server/
RUN npm ci
COPY packages/schema packages/schema
COPY packages/bindings packages/bindings
COPY packages/sdk packages/sdk
COPY server server
RUN npm run build --workspace @hedge/schema && npm run build --workspace @hedge/bindings && npm run build --workspace @hedge/sdk && npm run build --workspace @hedge/server

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/packages/schema/package.json packages/schema/
COPY --from=build /app/packages/bindings/package.json packages/bindings/
COPY --from=build /app/packages/sdk/package.json packages/sdk/
COPY --from=build /app/packages/frontend/package.json packages/frontend/
COPY --from=build /app/packages/nextjs/package.json packages/nextjs/
COPY --from=build /app/packages/foundry/package.json packages/foundry/
COPY --from=build /app/server/package.json server/
RUN npm ci --omit=dev --workspace @hedge/server && npm cache clean --force
COPY --from=build /app/packages/schema/dist packages/schema/dist
COPY --from=build /app/packages/bindings/dist packages/bindings/dist
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/server/dist server/dist
COPY --chown=node:node deployments deployments
USER node
EXPOSE 3003
CMD ["node", "server/dist/server.js"]
