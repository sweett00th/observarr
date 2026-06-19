FROM node:22-alpine AS client-build

WORKDIR /app

COPY client/package*.json ./client/
RUN cd client && if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY client ./client
RUN cd client && npm run build

FROM denoland/deno:2.8.3

WORKDIR /app

COPY deno.json deno.lock ./
COPY server ./server
RUN deno cache server/main.ts

COPY --from=client-build /app/client/dist ./client/dist

USER deno
EXPOSE 3020

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD deno eval --allow-env --allow-net "const port = Deno.env.get('PORT') || '3020'; const controller = new AbortController(); setTimeout(() => controller.abort(), 3000); const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal }); Deno.exit(response.ok ? 0 : 1);"

CMD ["deno", "run", "--allow-env", "--allow-net", "--allow-read=/app/server,/app/client/dist,/app/deno.json,/app/deno.lock", "server/main.ts"]
