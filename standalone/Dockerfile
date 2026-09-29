FROM node:22-bookworm-slim AS build
WORKDIR /app/standalone
COPY standalone/package.json standalone/package-lock.json ./
RUN npm ci
COPY standalone/tsconfig*.json ./
COPY standalone/eslint.config.mjs ./
COPY standalone/src ./src
COPY standalone/test ./test
COPY tests /app/tests
COPY web /app/web
RUN npm run check

FROM node:22-bookworm-slim
ENV NODE_ENV=production DASHBOARD_HOST=0.0.0.0
WORKDIR /app/standalone
COPY standalone/package.json standalone/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/standalone/dist ./dist
COPY web /app/web
USER node
EXPOSE 8790
CMD ["node", "dist/main.js"]
