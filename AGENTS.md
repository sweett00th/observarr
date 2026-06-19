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
- SQLite is the chosen local persistence layer. Do not add MongoDB, Redis, Prisma, or a separate database container without a new explicit request.
- The SQLite DB defaults to `/data/sms-gateway.db`; Unraid appdata should mount to `/data`.
- Local auth uses username/password credentials, PBKDF2 password hashes, HttpOnly cookies, and server-side sessions stored in SQLite.
- Initial admin bootstrap uses `ADMIN_USERNAME` and `ADMIN_PASSWORD` only when no users exist. Never create a hardcoded default admin password, and never log passwords.
- Do not add SSO, OAuth, Auth0, Google login, or any third-party identity provider.
- The Event Console is intentionally ephemeral and in-memory only. Do not add an events table, event migrations, or persistent event logging unless explicitly requested.
- Tracked media is the explicit persistence exception: once an admin selects `Track media`, matching future webhook events may be persisted to `tracked_media_events` for that media timeline.
- External services push live events into `sms-gateway` through webhook endpoints or scripts. Do not poll Jellyfin, Seerr, Radarr, Sonarr, SABnzbd, or other app APIs for the Event Console unless explicitly requested.
- `tools/mock-events.ts` is a local development helper that posts synthetic events into webhook endpoints. Keep it dev-only; it is not production polling or event ingestion logic.
- Internal port defaults to `3020`.
- Keep the app LAN-only. Do not assume public proxying, Cloudflare, or NPM.
- Secrets must be configured through environment variables in Unraid and must not be committed.
- Twilio variables are placeholders only. Do not implement Twilio sending until requested.
- Webhook routes may use the optional `SHARED_SECRET` header check via `x-sms-secret`.
