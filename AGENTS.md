# sms-gateway Agent Notes

This repo is the deployment scaffold for a small internal Unraid Docker app named `sms-gateway`.

The intended flow is:

```text
GitHub repo -> GitHub Actions Docker build -> GHCR image -> Unraid Docker template XML -> running Unraid container
```

Keep the app simple and LAN-only. Do not assume public proxying, Cloudflare, or NPM. Secrets must be configured through environment variables in Unraid and must not be committed.

Current scope:

- Plain JavaScript Node/Express.
- Internal port defaults to `3020`.
- GHCR image is `ghcr.io/joemess21/sms-gateway`.
- Unraid appdata default is `/mnt/user/appdata/sms-gateway`.
- Twilio variables are placeholders only. Do not add provider logic until requested.
- Webhook routes may use the optional `SHARED_SECRET` header check via `x-sms-secret`.
