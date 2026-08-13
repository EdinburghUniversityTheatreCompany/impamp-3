# Multi-stage build for impamp3 Soundboard

# Kept in step with .node-version and mise.toml — scripts/check_version_sync.sh
# fails the build if they drift. node:sqlite (the server-sync storage layer)
# needs Node >= 22.13, so this can never go below that.
ARG NODE_VERSION=24.19.0

# Build stage
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy application files
COPY . .

# Declare build-time arguments that Next.js needs during the build
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
# Make them available as environment variables within this build stage
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}

RUN echo "CLIENT_ID during build: $NEXT_PUBLIC_GOOGLE_CLIENT_ID"

# Build the application
RUN npm run build

# Production stage
# ARG is re-declared because a FROM line only sees ARGs declared before the
# first FROM, and the value does not carry into a new stage otherwise.
ARG NODE_VERSION
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

# Set environment to production
ENV NODE_ENV=production
ENV PORT=3000

# Copy necessary files from build stage
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
