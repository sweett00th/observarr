# sms-gateway

Minimal deployment scaffold for an internal Unraid Docker app that will receive home server webhooks and eventually send SMS notifications.

The first version is intentionally small: it starts an Express server, exposes health/version endpoints, accepts a test webhook, and ships as a Docker image through GitHub Container Registry.

## Local development

```powershell
npm install
npm start
```

By default the app listens on port `3020`. Override it with `PORT`.

```powershell
$env:PORT = "3020"
npm start
```

## Endpoints

- `GET /health` returns service health JSON.
- `GET /api/version` returns app, version, and build metadata.
- `POST /webhook/test` accepts JSON and logs a short summary. It does not send SMS.

Webhook routes support an optional shared secret. If `SHARED_SECRET` is set, requests must include:

```text
x-sms-secret: your-secret
```

For local development, leaving `SHARED_SECRET` unset allows webhook requests.

## First test

```powershell
curl http://localhost:3020/health
```

```powershell
curl -Method POST http://localhost:3020/webhook/test `
  -ContentType "application/json" `
  -Body '{"source":"manual","message":"hello from curl"}'
```

With `SHARED_SECRET` set:

```powershell
curl -Method POST http://localhost:3020/webhook/test `
  -Headers @{ "x-sms-secret" = "change-me" } `
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

Then test:

```powershell
curl http://localhost:3020/health
```

## GitHub Actions and GHCR

The workflow at `.github/workflows/docker-publish.yml` builds the Docker image on pushes to `main`, pull requests, and semver tags like `v0.1.0`.

Pull requests build but do not push images. Pushes to `main` and tags publish to:

```text
ghcr.io/joemess21/sms-gateway
```

Expected tags include:

- `latest` for the default branch
- `v0.1.0` style semver tags
- `sha-<commit>` for commit builds

## Unraid

The Unraid template is at `templates/sms-gateway.xml` and points to:

```text
ghcr.io/joemess21/sms-gateway:latest
```

To use it as a custom template repository in Unraid:

1. Push this repo to GitHub.
2. In Unraid, open Docker settings or Community Applications template repositories.
3. Add the GitHub repository URL:

```text
https://github.com/joemess21/sms-gateway
```

4. Install the `sms-gateway` template and configure environment variables.

Keep the app LAN-only. This scaffold does not assume public proxying, Cloudflare, NPM, or any external ingress.

## Environment variables

Copy `.env.example` for local reference only. In Unraid, set values through the container template.

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | HTTP port inside the container. Defaults to `3020`. |
| `TZ` | No | Timezone. Defaults to `America/New_York` in the Unraid template. |
| `SHARED_SECRET` | Recommended | Optional webhook secret checked against the `x-sms-secret` header. Set this in Unraid. |
| `TWILIO_ACCOUNT_SID` | Future | Placeholder for Twilio integration. Not used yet. |
| `TWILIO_AUTH_TOKEN` | Future | Placeholder for Twilio integration. Not used yet. |
| `TWILIO_FROM` | Future | Placeholder sender phone number. Not used yet. |
| `SMS_TO` | Future | Placeholder recipient phone number. Not used yet. |

Do not commit real secrets.
