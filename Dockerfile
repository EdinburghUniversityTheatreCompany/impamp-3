# Multi-stage build for impamp3 Soundboard

# Build stage
FROM node:22-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy application files
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:22-alpine AS runner
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
