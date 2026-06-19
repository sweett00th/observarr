import { type Context, Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import { eventBus, type EventSourceName, normalizeWebhookEvent } from "../events/eventBus.ts";
import { getSharedSecret } from "../lib/config.ts";
import { summarizePayload } from "../lib/payload.ts";
import { persistEventForTrackedMedia } from "../tracking/trackedMedia.ts";

const maxJsonBytes = 1024 * 1024;
const webhookSources: EventSourceName[] = [
  "jellyfin",
  "seerr",
  "radarr",
  "sonarr",
  "sabnzbd",
];

export function createWebhookRoutes(db: Database): Hono {
  const webhooks = new Hono();

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

  for (const source of webhookSources) {
    webhooks.post(`/${source}`, async (c) => {
      const payload = await readJsonPayload(c);

      if (!payload.ok) {
        return c.json(payload.body, payload.status);
      }

      const event = eventBus.publish(normalizeWebhookEvent(source, payload.value));
      persistEventForTrackedMedia(db, event);

      return c.json({
        ok: true,
        eventId: event.id,
      });
    });
  }

  webhooks.post("/test", async (c) => {
    const payload = await readJsonPayload(c);

    if (!payload.ok) {
      return c.json(payload.body, payload.status);
    }

    const summary = summarizePayload(payload.value);
    const event = eventBus.publish(normalizeWebhookEvent("test", payload.value));
    persistEventForTrackedMedia(db, event);

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
      eventId: event.id,
      summary,
    });
  });

  return webhooks;
}

type JsonPayloadResult =
  | { ok: true; value: unknown }
  | {
    ok: false;
    status: 400 | 413 | 415;
    body: {
      ok: false;
      status: string;
      error: string;
    };
  };

async function readJsonPayload(c: Context): Promise<JsonPayloadResult> {
  const contentType = c.req.header("content-type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 415,
      body: {
        ok: false,
        status: "unsupported_media_type",
        error: "Expected application/json",
      },
    };
  }

  const rawBody = await c.req.text();

  if (new TextEncoder().encode(rawBody).length > maxJsonBytes) {
    return {
      ok: false,
      status: 413,
      body: {
        ok: false,
        status: "payload_too_large",
        error: "JSON body exceeds the 1mb limit",
      },
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(rawBody) as unknown,
    };
  } catch {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        status: "bad_request",
        error: "Invalid JSON body",
      },
    };
  }
}
