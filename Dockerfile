FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm test && npm run lint && npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production BILLMITRA_WEB_HOST=0.0.0.0 BILLMITRA_WEB_DATA_DIR=/app/web-data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/web-data && chown node:node /app/web-data
COPY --from=build /app/dist ./dist
COPY --from=build /app/electron-dist ./electron-dist
COPY branches.json ./
USER node
EXPOSE 3000
CMD ["node", "electron-dist/electron/web.cjs"]
