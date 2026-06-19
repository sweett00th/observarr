# sms-gateway Agent Notes

This repo is a custom internal Unraid Docker app named `sms-gateway`.

The intended flow is:

```text
GitHub repo -> GitHub Actions Docker build -> GHCR image -> Unraid Docker template XML -> running Unraid container
```

Current durable architecture decisions:

- Backend runtime is Deno.
- Backend router/framework is Hono.
- Backend source lives under `server/`.
- Frontend is Vite + React + TypeScript + Material UI under `client/`.
- Production deployment is one Docker container: Deno serves API routes, webhook routes, and the built React frontend from `client/dist`.
- The previous Node/Express scaffold was intentionally replaced. Do not reintroduce Express or root Node backend dependencies.
- GHCR image is `ghcr.io/sweett00th/sms-gateway`.
- Unraid appdata default is `/mnt/user/appdata/sms-gateway`.
- Internal port defaults to `3020`.
- Keep the app LAN-only. Do not assume public proxying, Cloudflare, or NPM.
- Secrets must be configured through environment variables in Unraid and must not be committed.
- Twilio variables are placeholders only. Do not implement Twilio sending until requested.
- Do not add database/storage logic yet.
- Do not add auth/login yet.
- Webhook routes may use the optional `SHARED_SECRET` header check via `x-sms-secret`.
