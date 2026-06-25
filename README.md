# observarr

Internal Unraid Docker app for receiving home server webhooks and, later, sending SMS notifications. The app runs a Deno/Hono backend, a Vite React admin panel, local SQLite persistence, local username/password auth, Docker packaging, GHCR publishing, and an Unraid template.

No Twilio sending is implemented yet.

## Architecture

- Backend: Deno + TypeScript + Hono
- Frontend: Vite + React + TypeScript + Material UI
- Persistence: single local SQLite database
- Auth: local username/password with server-side SQLite sessions
- Live events: ephemeral in-memory Event Console streamed with Server-Sent Events
- Media timelines: identified media events persisted for audit and gap analysis
- Production: one Docker container
- Image: `ghcr.io/sweett00th/sms-gateway`
- Unraid template: `templates/sms-gateway.xml`

In production, the Deno/Hono server handles API and webhook routes and serves the built React app from `client/dist`.

In local development, the backend runs on port `3020` and Vite runs separately. Vite proxies `/api`, `/health`, and `/webhook` to `http://localhost:3020`.

SQLite uses `deno.land/x/sqlite@v3.9.1`, a WASM-based Deno SQLite module. That keeps the runtime self-contained and avoids `--allow-ffi`; the tradeoff is that this library does not support SQLite WAL mode.

## Local Development

Start the backend:

```powershell
$env:DB_PATH=".data/sms-gateway.db"
$env:ADMIN_PASSWORD="change-me"
deno task dev:server
```

Start the frontend:

```powershell
deno task dev:client
```

Run the backend, frontend, and a local mock event stream together:

```powershell
deno task dev:mock
```

Build the frontend:

```powershell
deno task build:client
```

Start the production server locally after building the frontend:

```powershell
deno task start
```

Typecheck the backend:

```powershell
deno task check
```

Format backend/Deno files:

```powershell
deno task fmt
```

Frontend typechecking is part of the client build and can also be run directly:

```powershell
npm --prefix client run typecheck
```

## Routes

- `GET /` serves the React admin panel when `client/dist` exists.
- `GET /health` returns service health and Deno runtime info.
- `GET /api/version` returns app, version, runtime, environment, and build metadata.
- `GET /api/auth/status` returns whether any local user exists.
- `GET /api/auth/me` returns the current user or `401`.
- `POST /api/auth/login` creates a server-side session and sets an HttpOnly cookie.
- `POST /api/auth/logout` deletes the current session and clears the cookie.
- `POST /api/auth/password` changes the current user's password after verifying the current password.
- `GET /api/admin/overview` returns SQLite-backed dashboard counts and provider configuration status. It requires login.
- `GET /api/events/recent` returns current in-memory Event Console events. It requires login.
- `GET /api/events/stream` streams live Event Console events with Server-Sent Events. It requires login.
- `GET /api/media-timelines` lists persisted media timelines. It requires login.
- `DELETE /api/media-timelines` deletes selected media timelines by id. It requires login.
- `POST /api/media-timelines/from-event` resolves the media timeline for a live event. It requires login.
- `GET /api/media-timelines/:id` returns a media timeline. It requires login.
- `POST /webhook/test` accepts JSON, logs a summary, emits a live test event, and returns the summary. It does not send SMS.
- `POST /webhook/jellyfin`, `/webhook/seerr`, `/webhook/radarr`, `/webhook/sonarr`, and `/webhook/sabnzbd` accept JSON and emit normalized live events. They do not send SMS.

Unknown `/api/*` and `/webhook/*` routes return JSON 404 responses. Unknown non-API routes fall back to the React `index.html` for future client-side routing.

## Webhook Secret

Webhook routes support an optional shared secret. If `SHARED_SECRET` is set, requests must include:

```text
x-sms-secret: your-secret
```

If `SHARED_SECRET` is unset, webhook requests are allowed and the server logs a startup warning. Set it in Unraid for normal use.

## Event Console

The authenticated app includes a collapsible terminal-like Event Console fixed to the bottom of the viewport. It shows recent webhook events and streams new events live with Server-Sent Events from `/api/events/stream`.

The Event Console buffer is intentionally ephemeral and in-memory only:

- Events are lost when the container restarts.
- The server keeps only a short runtime ring buffer.

Separately, every identifiable media webhook event is persisted to Media Timelines. If an event can be associated to a movie or series, the app creates or updates that media item and appends the event to its timeline.

The default ring buffer keeps events from the last `10` minutes and caps the list at `250` events. Override those with:

```env
EVENT_BUFFER_MINUTES=10
EVENT_BUFFER_MAX=250
EVENT_RAW_MAX_BYTES=20000
```

External apps still need to be configured to push webhooks into this app. This feature does not poll Jellyfin, Jellyseerr/Seerr, Radarr, Sonarr, SABnzbd, or any other app API.

The console supports source filters for Jellyfin, Seerr, Radarr, Sonarr, SABnzbd, and System/Test. Webhook payloads are normalized into compact events. Expanding an event row shows the sanitized raw webhook payload. Obvious secret-looking fields such as tokens, passwords, API keys, and authorization headers are recursively redacted. If the sanitized raw payload exceeds `EVENT_RAW_MAX_BYTES`, the expanded view shows a truncated preview with byte metadata.

## Media Timelines

The dashboard includes a `Media Timelines` widget. Open it to see media items identified from webhook events. The page has a searchable media list, a scrollable sorted event list for the selected item, and a horizontal timeline graph with source-colored dots. Hover over a dot to see event details and the gap from the previous step.

Media timeline rows can be selected individually or in bulk from the left column and deleted manually. Deleting a media item removes its associated timeline events through SQLite cascade cleanup.

Timeline persistence is automatic:

1. A webhook event arrives.
2. The server normalizes the event.
3. The server identifies the distinct piece of media using strong IDs, structured fields, or loose normalized title matching.
4. If the media has been seen before, the event is appended to that media timeline.
5. If the media is new, a timeline is created and the event is appended.

Media matching is intentionally loose in this pass. The app first tries derived keys from common fields such as `movie.title`, `series.title`, `tmdbId`, `imdbId`, `tvdbId`, `title`, `subject`, and media type hints. If that misses, incoming events are compared against existing media titles using normalized text from the event title, message, entity title, and sanitized raw payload. Source-specific matching can be improved later as real payload samples arrive.

Media Timelines also stores a thumbnail URL when webhook payloads provide one through common poster/image fields such as `posterUrl`, `thumbnailUrl`, `imageUrl`, `movie.remotePoster`, `series.remotePoster`, or image arrays from media managers. If no thumbnail is available, the UI shows an initial-based fallback.

When an event type normalizes to `MEDIA_AVAILABLE`, the media item is marked available and scheduled for cleanup after 14 days. Cleanup runs once on startup and then once per day while the container is running.

For local development, the repo includes a mock webhook event generator. It posts synthetic Jellyfin, Seerr, Radarr, Sonarr, SABnzbd, and test events into the same webhook endpoints external apps use:

```powershell
deno task mock:events
```

Send one event and exit:

```powershell
deno task mock:events:once
```

The tool emits realistic multi-step media journeys. A movie flow looks like Seerr request, Seerr approval, Radarr grab, SABnzbd download, Radarr import, Seerr available, Jellyfin library update, and Jellyfin playback. Series flows use Sonarr in the equivalent steps. Events in one journey share media IDs/titles so Media Timelines can reconstruct end-to-end behavior.

The tool reads `.env`, sends `SHARED_SECRET` as `x-sms-secret` when set, and defaults to `http://localhost:$PORT`. Optional local knobs:

```env
WEBHOOK_BASE_URL=http://localhost:3020
MOCK_EVENT_INTERVAL_MS=2500
```

## SQLite Persistence

The app stores local state in one SQLite database file. By default:

```text
/data/sms-gateway.db
```

Override it with `DB_PATH`. In Unraid, `/mnt/user/appdata/sms-gateway` is mounted to `/data`, so the database survives container updates.

Migrations run automatically on startup and are tracked in `schema_migrations`. Current tables include `users`, `sessions`, `message_receipts`, `notification_profiles`, `event_templates`, `provider_settings`, `webhook_events`, `media_items`, and `media_events`. Older development tables `tracked_media` and `tracked_media_events` may also exist on upgraded local databases.

To reset the app in local development, stop the server and delete the SQLite file you used for `DB_PATH`, for example:

```powershell
Remove-Item .data\sms-gateway.db
```

## Local Auth

The first admin user is bootstrapped only when the `users` table is empty.

- Set `ADMIN_PASSWORD` before first start.
- `ADMIN_USERNAME` defaults to `admin`.
- Passwords are stored as PBKDF2-SHA256 hashes with per-user salts.
- `ADMIN_PASSWORD` is ignored after any user exists.
- There is no public registration and no third-party login.

Sessions are random opaque tokens stored in an HttpOnly `sms_gateway_session` cookie. Only a SHA-256 hash of each session token is stored in SQLite. `SESSION_TTL_DAYS` controls expiry and defaults to `7`. Keep `COOKIE_SECURE=false` for local HTTP/LAN use; set it to `true` only behind HTTPS.

Authenticated users can open the profile drawer by clicking their username in the upper-right app bar. The drawer shows local account details and allows changing the password. Password changes require the current password and store a fresh PBKDF2-SHA256 hash.

## First Tests

```powershell
curl http://localhost:3020/health
```

```powershell
curl http://localhost:3020/api/version
```

```powershell
curl http://localhost:3020/api/auth/status
```

Unauthenticated admin API calls should return `401`:

```powershell
curl http://localhost:3020/api/admin/overview
```

Log in from the React UI at `http://localhost:3020/`, or use the API and keep the returned cookie in your client.

```powershell
curl -Method POST http://localhost:3020/webhook/test `
  -ContentType "application/json" `
  -Headers @{ "x-sms-secret" = "your-secret" } `
  -Body '{"source":"manual","message":"hello from curl"}'
```

Example source webhooks:

```powershell
curl -Method POST http://localhost:3020/webhook/radarr `
  -ContentType "application/json" `
  -Headers @{ "x-sms-secret" = "your-secret" } `
  -Body '{"eventType":"MovieDownloaded","movie":{"title":"Example Movie"},"message":"Download complete"}'
```

## Docker

Build locally:

```powershell
docker build -t sms-gateway .
```

Run locally:

```powershell
docker run --rm -p 3020:3020 `
  -e PORT=3020 `
  -e TZ=America/New_York `
  -e DB_PATH=/data/sms-gateway.db `
  -e ADMIN_USERNAME=admin `
  -e ADMIN_PASSWORD=change-me `
  -e SESSION_TTL_DAYS=7 `
  -e COOKIE_SECURE=false `
  -e EVENT_BUFFER_MINUTES=10 `
  -e EVENT_BUFFER_MAX=250 `
  -v ${PWD}\.data:/data `
  sms-gateway
```

Open the admin panel:

```text
http://localhost:3020/
```

The final image runs the Deno server, not the Vite dev server. The Docker build compiles the frontend first, copies `client/dist` into the final Deno image, creates `/data`, and runs with explicit Deno permissions for env, network, `/app` reads, `/data` reads, and `/data` writes.

## GitHub Actions and GHCR

`.github/workflows/docker-publish.yml` builds the Docker image on pushes to `main`, pull requests, and semver tags like `v0.1.0`.

Pull requests build but do not push images. Pushes to `main` and tags publish to:

```text
ghcr.io/sweett00th/sms-gateway
```

Expected tags include:

- `latest` for the default branch
- `v0.1.0` style semver tags
- `sha-<commit>` for commit builds

## Unraid

The Unraid template points to:

```text
ghcr.io/sweett00th/sms-gateway:latest
```

The WebUI opens the admin panel at:

```text
http://[IP]:[PORT:3020]/
```

To add the custom template repository in Unraid, use:

```text
https://github.com/sweett00th/sms-gateway
```

Keep the app LAN-only. This scaffold does not assume public proxying, Cloudflare, NPM, or any external ingress.

Set `ADMIN_PASSWORD` before the first start so the app can create the initial local admin user. After that, changing `ADMIN_USERNAME` or `ADMIN_PASSWORD` in the template will not overwrite existing users.

## Environment Variables

Copy `.env.example` for local reference only. In Unraid, set values through the container template.

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | HTTP port inside the container. Defaults to `3020`. |
| `TZ` | No | Timezone. Defaults to `America/New_York` in the Unraid template. |
| `DB_PATH` | No | SQLite database path. Defaults to `/data/sms-gateway.db`. |
| `ADMIN_USERNAME` | Bootstrap | Initial admin username used only when no users exist. Defaults to `admin`. |
| `ADMIN_PASSWORD` | Bootstrap | Initial admin password used only when no users exist. No safe default; set in Unraid before first start. |
| `SESSION_TTL_DAYS` | No | Server-side session lifetime in days. Defaults to `7`. |
| `COOKIE_SECURE` | No | Adds the Secure cookie flag when `true`. Keep `false` for LAN HTTP. |
| `EVENT_BUFFER_MINUTES` | No | In-memory Event Console retention window in minutes. Defaults to `10`. |
| `EVENT_BUFFER_MAX` | No | Maximum in-memory Event Console event count. Defaults to `250`. |
| `EVENT_RAW_MAX_BYTES` | No | Maximum sanitized raw payload bytes included per in-memory event. Defaults to `20000`. |
| `WEBHOOK_BASE_URL` | Dev only | Mock event generator target URL. Defaults to `http://localhost:$PORT`. |
| `MOCK_EVENT_INTERVAL_MS` | Dev only | Mock event generator interval. Defaults to `2500`. |
| `SHARED_SECRET` | Recommended | Optional webhook secret checked against the `x-sms-secret` header. Set this in Unraid. |
| `TWILIO_ACCOUNT_SID` | Future | Placeholder for Twilio configuration. Used only to report whether provider settings appear configured. |
| `TWILIO_AUTH_TOKEN` | Future | Placeholder for Twilio configuration. No SMS is sent. |
| `TWILIO_FROM` | Future | Placeholder sender phone number. No SMS is sent. |
| `SMS_TO` | Future | Placeholder recipient phone number. No SMS is sent. |

Do not commit real secrets.
