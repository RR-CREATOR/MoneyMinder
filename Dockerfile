FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV NODE_ENV=production \
    DATA_DIR=/var/lib/moneyminder \
    PORT=3000

WORKDIR /app

COPY package*.json ./
RUN npm install --global npm@10.9.8 --ignore-scripts --no-audit --no-fund \
    && test "$(npm --version)" = "10.9.8" \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY server ./server
COPY public ./public
RUN mkdir -p /var/lib/moneyminder && chown node:node /var/lib/moneyminder

VOLUME ["/var/lib/moneyminder"]
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/app.js"]
