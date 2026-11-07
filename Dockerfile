FROM node:24-bookworm-slim

WORKDIR /app

# Install production dependencies first for optimal Docker layer caching
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source and frontend assets
COPY server.js ./
COPY src ./src
COPY public ./public

# Create persistent SQLite data directory with full permissions for Synology NAS bind mounts
RUN mkdir -p /app/data && chmod -R 777 /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV HTTPS_PORT=3443

EXPOSE 3000 3443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
