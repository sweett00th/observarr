import { Hono } from "@hono/hono";
import { getSharedSecret } from "../lib/config.ts";
import { summarizePayload } from "../lib/payload.ts";

const webhooks = new Hono();
const maxJsonBytes = 1024 * 1024;

webhooks.use("*", async (c, next) => {
  const sharedSecret = getSharedSecret();

  if (sharedSecret && c.req.header("x-sms-secret") !== sharedSecret) {
    return c.json(
      {
        ok: false,
        status: "unauthorized",
        error: "Invalid or missing webhook secret",
      },
      401,
    );
  }

  await next();
});

webhooks.post("/test", async (c) => {
  const contentType = c.req.header("content-type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return c.json(
      {
        ok: false,
        status: "unsupported_media_type",
        error: "Expected application/json",
      },
      415,
    );
  }

  const rawBody = await c.req.text();

  if (new TextEncoder().encode(rawBody).length > maxJsonBytes) {
    return c.json(
      {
        ok: false,
        status: "payload_too_large",
        error: "JSON body exceeds the 1mb limit",
      },
      413,
    );
  }

  let payload: unknown;

  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return c.json(
      {
        ok: false,
        status: "bad_request",
        error: "Invalid JSON body",
      },
      400,
    );
  }

  const summary = summarizePayload(payload);

  console.log(
    JSON.stringify({
      event: "webhook.test.received",
      receivedAt: new Date().toISOString(),
      summary,
    }),
  );

  return c.json({
    ok: true,
    status: "received",
    summary,
  });
});

export default webhooks;
