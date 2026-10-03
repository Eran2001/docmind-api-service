# One image for the API, the worker and the one-off migration: they differ only in the command.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/database/migrations ./src/database/migrations
COPY package.json ./
# Uploaded files live here: mount a volume (the compose file does).
RUN mkdir -p /data/storage && chown -R node:node /data /app
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
