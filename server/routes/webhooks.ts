import { type Context, Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import { eventBus, type EventSourceName, normalizeWebhookEvent } from "../events/eventBus.ts";
import { getSharedSecret, getTextbeltWebhookSecret } from "../lib/config.ts";
import { dispatchNotificationsForEvent } from "../notifications/dispatchNotifications.ts";
import { subscribeRequesterToSeerrMedia } from "../notifications/mediaInterests.ts";
import { recordTextbeltReply } from "../notifications/phoneNumbers.ts";
import { summarizePayload } from "../lib/payload.ts";
import { persistMediaEvent } from "../tracking/mediaTimelines.ts";

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

  webhooks.post("/textbelt/reply/:token?", async (c) => {
    const secret = getTextbeltWebhookSecret();
    if (secret && c.req.param("token") !== secret) {
      return c.json({ ok: false, status: "unauthorized", error: "Invalid webhook token" }, 401);
    }

    const payload = await readJsonPayload(c);
    if (!payload.ok) {
      return c.json(payload.body, payload.status);
    }

    const data = isObject(payload.value) ? payload.value : {};
    try {
      const result = recordTextbeltReply(db, {
        fromNumber: data.fromNumber,
        text: data.text,
        raw: data,
      });
      console.log(JSON.stringify({
        event: "textbelt.reply.received",
        at: new Date().toISOString(),
        matched: result.matched,
        interpretedStatus: result.status,
        profileId: result.phone?.profileId ?? null,
        phoneNumberId: result.phone?.id ?? null,
      }));
      return c.json({ ok: true, matched: result.matched, status: result.status });
    } catch (error) {
      return c.json({
        ok: false,
        status: "bad_request",
        error: error instanceof Error ? error.message : "Invalid Textbelt reply",
      }, 400);
    }
  });
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
      const media = persistMediaEvent(db, event);
      const autoSubscription = subscribeRequesterToSeerrMedia(db, event, media);

      if (source === "seerr") {
        console.log(JSON.stringify({
          event: "media_interest.seerr_requester_subscription",
          at: new Date().toISOString(),
          liveEventId: event.id,
          mediaItemId: media?.id ?? null,
          matched: autoSubscription.matched,
          created: autoSubscription.created,
          updated: autoSubscription.updated,
          profileId: autoSubscription.profileId,
          reason: autoSubscription.reason ?? null,
        }));
      }

      const notifications = await dispatchNotificationsForEvent(db, event, {
        mediaItemId: media?.id ?? null,
      });

      return c.json({
        ok: true,
        eventId: event.id,
        notifications,
        autoSubscription,
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
    persistMediaEvent(db, event);

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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
