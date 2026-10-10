FROM node:22-slim
# Friday core has zero npm dependencies. Chrome/DSH are added in later phases.
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY public ./public
ENV FRIDAY_DATA_DIR=/data FRIDAY_HOST=0.0.0.0 FRIDAY_ALLOW_NONLOOPBACK=1 FRIDAY_PORT=4317 NODE_ENV=production
VOLUME /data
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4317/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
