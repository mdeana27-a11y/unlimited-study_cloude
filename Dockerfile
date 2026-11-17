# Cloud Run / any container host. State lives OUTSIDE the container: PostgreSQL (Cloud SQL) + file storage (GCS bucket or a mounted volume).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY client ./client
COPY scripts ./scripts
COPY data ./data
ENV NODE_ENV=production PORT=8080
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start.js"]
