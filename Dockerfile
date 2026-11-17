# kube-cosmos: ein Image mit Backend (Node) + gebautem Frontend.
# Bauen:  docker build -t kube-cosmos:0.1.0 .

# 1) Frontend bauen
FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# 2) Backend kompilieren
FROM node:22-alpine AS backend
WORKDIR /src/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# 3) Laufzeit-Image
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MODE=readonly \
    K8S_AUTH=incluster \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/public
COPY --from=backend /src/backend/node_modules ./node_modules
COPY --from=backend /src/backend/dist ./dist
COPY --from=backend /src/backend/package.json ./
COPY --from=frontend /src/frontend/dist ./public
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
