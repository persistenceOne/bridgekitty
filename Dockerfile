# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Stage 2: Production
FROM node:22-alpine AS runtime

WORKDIR /app

# Non-root user for security
RUN addgroup -S bridgekitty && adduser -S bridgekitty -G bridgekitty

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Environment variables are passed at runtime, never baked in
# Optional: LIFI_API_KEY, DEBRIDGE_API_KEY, SQUID_INTEGRATOR_ID, PRIVATE_KEY, MNEMONIC

USER bridgekitty

ENTRYPOINT ["node", "dist/index.js"]
