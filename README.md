# sms-gateway

Internal Unraid Docker app for receiving home server webhooks and, later, sending SMS notifications. This version focuses on the deployable app shell: a Deno/Hono backend, a Vite React admin panel, Docker packaging, GHCR publishing, and an Unraid template.

No Twilio sending, database/storage, login, or auth system is implemented yet.

## Architecture

- Backend: Deno + TypeScript + Hono
- Frontend: Vite + React + TypeScript + Material UI
- Production: one Docker container
- Image: `ghcr.io/sweett00th/sms-gateway`
- Unraid template: `templates/sms-gateway.xml`

In production, the Deno/Hono server handles API and webhook routes and serves the built React app from `client/dist`.

In local development, the backend runs on port `3020` and Vite runs separately. Vite proxies `/api`, `/health`, and `/webhook` to `http://localhost:3020`.

## Local Development

Start the backend:

```powershell
deno task dev:server
```

Start the frontend:

```powershell
deno task dev:client
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
- `GET /api/admin/overview` returns placeholder dashboard counts and provider configuration status.
- `POST /webhook/test` accepts JSON, logs a summary, and returns the summary. It does not send SMS.

Unknown `/api/*` and `/webhook/*` routes return JSON 404 responses. Unknown non-API routes fall back to the React `index.html` for future client-side routing.

## Webhook Secret

Webhook routes support an optional shared secret. If `SHARED_SECRET` is set, requests must include:

```text
x-sms-secret: your-secret
```

If `SHARED_SECRET` is unset, webhook requests are allowed and the server logs a startup warning. Set it in Unraid for normal use.

## First Tests

```powershell
curl http://localhost:3020/health
```

```powershell
curl http://localhost:3020/api/version
```

```powershell
curl http://localhost:3020/api/admin/overview
```

```powershell
curl -Method POST http://localhost:3020/webhook/test `
  -ContentType "application/json" `
  -Body '{"source":"manual","message":"hello from curl"}'
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
  sms-gateway
```

Open the admin panel:

```text
http://localhost:3020/
```

The final image runs the Deno server, not the Vite dev server. The Docker build compiles the frontend first, copies `client/dist` into the final Deno image, and runs with explicit Deno permissions for env, network, and app file reads.

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

## Environment Variables

Copy `.env.example` for local reference only. In Unraid, set values through the container template.

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | HTTP port inside the container. Defaults to `3020`. |
| `TZ` | No | Timezone. Defaults to `America/New_York` in the Unraid template. |
| `SHARED_SECRET` | Recommended | Optional webhook secret checked against the `x-sms-secret` header. Set this in Unraid. |
| `TWILIO_ACCOUNT_SID` | Future | Placeholder for Twilio configuration. Used only to report whether provider settings appear configured. |
| `TWILIO_AUTH_TOKEN` | Future | Placeholder for Twilio configuration. No SMS is sent. |
| `TWILIO_FROM` | Future | Placeholder sender phone number. No SMS is sent. |
| `SMS_TO` | Future | Placeholder recipient phone number. No SMS is sent. |

Do not commit real secrets.
