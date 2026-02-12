# Use Node.js LTS with Alpine for smaller image
FROM node:20-alpine

# Install ffmpeg (required for video processing)
RUN apk add --no-cache ffmpeg

# Create app directory
WORKDIR /app

# Copy package files first (better layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application source
COPY . .

# Create temp directory for video processing
RUN mkdir -p /app/temp /app/sessions

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose the port
EXPOSE 3000

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/auth/status || exit 1

# Start the application
CMD ["node", "server.js"]
