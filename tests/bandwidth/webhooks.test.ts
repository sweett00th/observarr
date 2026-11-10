import assert from "node:assert/strict";
import { eventBus } from "../../server/events/eventBus.ts";
import { createWebhookRoutes, type JellyfinWebhookContext } from "../../server/routes/webhooks.ts";
import { createTestDb, playbackEvent } from "./helpers.ts";

function post(
  routes: ReturnType<typeof createWebhookRoutes>,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return routes.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

/** Runs `body` with SHARED_SECRET set to `secret` (or unset), then puts it back. */
async function withSharedSecret(secret: string | null, body: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get("SHARED_SECRET");
  if (secret === null) {
    Deno.env.delete("SHARED_SECRET");
  } else {
    Deno.env.set("SHARED_SECRET", secret);
  }

  try {
    await body();
  } finally {
    if (previous === undefined) {
      Deno.env.delete("SHARED_SECRET");
    } else {
      Deno.env.set("SHARED_SECRET", previous);
    }
  }
}

Deno.test("Jellyfin webhooks reach bandwidth automation and are otherwise handled as before", async () => {
  await withSharedSecret(null, async () => {
    const db = createTestDb();

    try {
      const seen: Array<{ payload: unknown; context: JellyfinWebhookContext }> = [];
      const routes = createWebhookRoutes(db, {
        onJellyfinWebhook: (payload, context) => seen.push({ payload, context }),
      });
      const payload = playbackEvent("PlaybackStart");

      const response = await post(routes, "/jellyfin", payload);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].payload, payload, "the hook sees the parsed payload, unchanged");
      assert.equal(
        seen[0].context.authenticated,
        false,
        "without SHARED_SECRET nothing is authenticated",
      );
      assert.equal(typeof seen[0].context.receivedAt, "number");

      const event = eventBus.findById(body.eventId);
      assert.ok(event, "the Event Console still gets the event");
      assert.equal(event.source, "jellyfin");
      assert.equal(event.eventType, "PlaybackStart");

      await post(routes, "/sonarr", { eventType: "Grab", series: { title: "Some Show" } });
      await post(routes, "/sabnzbd", { event: "download_complete", title: "Some.Show.S01E01" });
      assert.equal(seen.length, 1, "other sources never reach the hook");

      const quiet = console.error;
      console.error = () => {};
      try {
        const failing = createWebhookRoutes(db, {
          onJellyfinWebhook: () => {
            throw new Error("boom");
          },
        });
        const failed = await post(failing, "/jellyfin", payload);
        assert.equal(failed.status, 200, "a failing hook never breaks the webhook");
      } finally {
        console.error = quiet;
      }
    } finally {
      db.close();
    }
  });
});

Deno.test("with SHARED_SECRET set, only requests presenting it reach bandwidth automation", async () => {
  await withSharedSecret("hunter2-secret", async () => {
    const db = createTestDb();

    try {
      const seen: JellyfinWebhookContext[] = [];
      const routes = createWebhookRoutes(db, {
        onJellyfinWebhook: (_payload, context) => seen.push(context),
      });
      const payload = playbackEvent("PlaybackStart");

      const missing = await post(routes, "/jellyfin", payload);
      assert.equal(missing.status, 401);
      const wrong = await post(routes, "/jellyfin", payload, { "x-sms-secret": "guess" });
      assert.equal(wrong.status, 401);
      assert.equal(seen.length, 0, "turned away before bandwidth automation sees anything");

      const header = await post(routes, "/jellyfin", payload, { "x-sms-secret": "hunter2-secret" });
      assert.equal(header.status, 200);
      const query = await post(routes, "/jellyfin?secret=hunter2-secret", payload);
      assert.equal(query.status, 200);
      assert.deepEqual(seen.map((context) => context.authenticated), [true, true]);

      const malformed = await routes.request("/jellyfin", {
        method: "POST",
        headers: { "content-type": "application/json", "x-sms-secret": "hunter2-secret" },
        body: "{not json",
      });
      assert.equal(malformed.status, 400);
      assert.equal(seen.length, 2, "an unparsable body never reaches the hook");
    } finally {
      db.close();
    }
  });
});
