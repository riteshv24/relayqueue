FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npm test

FROM node:24-alpine AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/relayqueue.db
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /app/data && chown -R node:node /app
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js", "--demo"]
