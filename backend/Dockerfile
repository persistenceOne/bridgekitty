FROM node:22-alpine AS base
WORKDIR /app

# Install tsx globally for TypeScript execution
RUN npm install -g tsx

# Install dependencies for the root package (backends use these)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install backend-specific dependencies (including tsx for runtime)
COPY backend/package.json ./backend/
RUN cd backend && npm install

# Copy source files
COPY src/ ./src/
COPY backend/src/ ./backend/src/
COPY tsconfig.json ./

# Use tsx to run TypeScript directly (no build step required)
WORKDIR /app/backend
ENV NODE_ENV=production

EXPOSE 3000

CMD ["tsx", "src/index.ts"]
