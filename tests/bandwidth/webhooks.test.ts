import assert from "node:assert/strict";
import { eventBus } from "../../server/events/eventBus.ts";
import { createWebhookRoutes } from "../../server/routes/webhooks.ts";
import { createTestDb } from "./helpers.ts";

function post(routes: ReturnType<typeof createWebhookRoutes>, path: string, payload: unknown) {
  return routes.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

Deno.test("Jellyfin webhooks reach bandwidth automation and are otherwise handled as before", async () => {
  const previousSecret = Deno.env.get("SHARED_SECRET");
  Deno.env.delete("SHARED_SECRET");
  const db = createTestDb();

  try {
    const seen: unknown[] = [];
    const routes = createWebhookRoutes(db, { onJellyfinWebhook: (payload) => seen.push(payload) });
    const payload = {
      NotificationType: "PlaybackStart",
      Name: "A Movie",
      ItemType: "Movie",
      ItemId: "movie-1",
      DeviceId: "tv",
      IsPaused: false,
    };

    const response = await post(routes, "/jellyfin", payload);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(seen, [payload], "the hook sees the parsed payload, unchanged");

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
    if (previousSecret !== undefined) {
      Deno.env.set("SHARED_SECRET", previousSecret);
    }
  }
});
