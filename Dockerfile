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

# Copy necessary files from build stage. `node` (uid 1000) ships with the base
# image; owning these lets the app run unprivileged.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# The server-sync SQLite database lives here (IMPAMP_DB_PATH=/data/impamp.db,
# config/deploy.yml). Creating it in the image owned by `node` is what makes a
# *newly created* named volume land with the right ownership — Docker seeds a
# fresh volume from the image directory it is mounted over. An volume that
# already exists keeps whatever ownership it has, so an existing deployment
# needs a one-off `chown -R 1000:1000` on it; see config/deploy.yml.
RUN mkdir -p /data && chown node:node /data

# Drop root. The server needs no privileged port and writes nothing outside
# /data, so running as uid 0 only widened what a Next.js RCE or path traversal
# would reach — including that volume.
USER node

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
