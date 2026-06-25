# ObservaRR Agent Notes

This repo is a custom internal Unraid Docker app named `observarr`. The user-facing product name is
`ObservaRR`.

The intended flow is:

```text
GitHub repo -> GitHub Actions Docker build -> GHCR image -> Unraid Docker template XML -> running Unraid container
```

Current durable architecture decisions:

- Backend runtime is Deno.
- Backend router/framework is Hono.
- Backend source lives under `server/`.
- Frontend is Vite + React + TypeScript + Material UI under `client/`.
- Production deployment is one Docker container: Deno serves API routes, webhook routes, and the
  built React frontend from `client/dist`.
- The previous Node/Express scaffold was intentionally replaced. Do not reintroduce Express or root
  Node backend dependencies.
- GHCR image is `ghcr.io/sweett00th/observarr`.
- Unraid appdata default is `/mnt/user/appdata/observarr`.
- SQLite is the chosen local persistence layer. Do not add MongoDB, Redis, Prisma, or a separate
  database container without a new explicit request.
- The SQLite DB defaults to `/data/observarr.db`; Unraid appdata should mount to `/data`.
- Local auth uses username/password credentials, PBKDF2 password hashes, HttpOnly cookies, and
  server-side sessions stored in SQLite.
- Initial admin bootstrap uses `ADMIN_USERNAME` and `ADMIN_PASSWORD` only when no users exist. Never
  create a hardcoded default admin password, and never log passwords.
- Do not add SSO, OAuth, Auth0, Google login, or any third-party identity provider.
- The Event Console live buffer is intentionally ephemeral and in-memory only.
- Media Timelines persist every identifiable media webhook event to SQLite in `media_items` and
  `media_events`.
- Media timeline cleanup runs on startup and daily. `MEDIA_AVAILABLE` marks lifecycle completion and
  schedules cleanup 14 days later.
- External services push live events into ObservaRR through webhook endpoints or scripts. Do not
  poll Jellyfin, Seerr, Radarr, Sonarr, SABnzbd, or other app APIs for the Event Console unless
  explicitly requested.
- `tools/mock-events.ts` is a local development helper that posts synthetic events into webhook
  endpoints. Keep it dev-only; it is not production polling or event ingestion logic.
- Internal port defaults to `3020`.
- Keep the app LAN-only. Do not assume public proxying, Cloudflare, or NPM.
- Secrets must be configured through environment variables in Unraid and must not be committed.
- Textbelt is the only supported SMS provider. Do not add Twilio, Telnyx, Plivo, SMTP, or other
  delivery providers without an explicit request.
- `NOTIFICATIONS_ENABLED=false` is the safe default; real SMS requires `NOTIFICATIONS_ENABLED=true`,
  `TEXTBELT_KEY`, an enabled profile phone number with explicit opt-in, matching profile event
  preferences, and when media is identified a matching profile media interest.
- Jellyfin import uses server-only `JELLYFIN_URL` and `JELLYFIN_API_KEY`; never return or log the
  API key.
- Notification profiles are future recipients, not ObservaRR login users, and imported people must
  not be automatically opted into notifications or SMS consent.
- Event templates are global per `(source, event_type)`; profile preferences only determine
  recipient interest and future channel eligibility.
- Email templates may be stored and previewed, but email transport is not implemented.
- Imported Jellyfin avatars are cached under `/data/avatars` and served only through authenticated
  profile avatar routes.
- Webhook routes may use the optional `SHARED_SECRET` header check via `x-sms-secret`.
- Textbelt reply handling is exposed at `POST /webhook/textbelt/reply`; keep it free of
  shared-secret requirements because Textbelt posts directly to it.
- Do not send SMS opt-in welcome texts automatically. Admins trigger welcome texts per phone number
  or for unsent numbers on a profile. The welcome consent message is the global editable template
  `system:sms_opt_in_welcome`.
- Profiles may have multiple phone numbers. Dispatch uses enabled, opted-in phone-number rows, not
  the legacy single profile phone field.
- Media notification dispatch is gated by profile media interests. Profiles default to zero
  movie/series interests.
