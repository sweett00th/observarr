import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/deno";
import { createBandwidthController } from "./bandwidth/index.ts";
import { initializeDatabase } from "./db/index.ts";
import { requireAdmin } from "./middleware/auth.ts";
import { createAdminRoutes } from "./routes/admin.ts";
import { createAuthRoutes } from "./routes/auth.ts";
import { createBandwidthAutomationRoutes } from "./routes/bandwidthAutomation.ts";
import { startDeliveryStatusPoller } from "./notifications/deliveryStatusPoller.ts";
import { createEventRoutes } from "./routes/events.ts";
import { createEventTemplateRoutes } from "./routes/eventTemplates.ts";
import { createJellyfinIntegrationRoutes } from "./routes/jellyfinIntegrations.ts";
import health from "./routes/health.ts";
import { createMediaTimelineRoutes } from "./routes/mediaTimelines.ts";
import { createMessageReceiptRoutes } from "./routes/messageReceipts.ts";
import { createNotificationProfileRoutes } from "./routes/notificationProfiles.ts";
import { createSteamreviewsIntegrationRoutes } from "./routes/steamreviewsIntegrations.ts";
import { createTrackedMediaRoutes } from "./routes/trackedMedia.ts";
import { createWebhookRoutes } from "./routes/webhooks.ts";
import { getPort, getSharedSecret } from "./lib/config.ts";
import {
  cleanupExpiredMediaTimelines,
  startMediaTimelineCleanupJob,
} from "./tracking/mediaTimelines.ts";

const db = await initializeDatabase();
const cleanedTimelines = cleanupExpiredMediaTimelines(db);
startMediaTimelineCleanupJob(db);
startDeliveryStatusPoller(db);
const bandwidthController = createBandwidthController(db);

if (cleanedTimelines > 0) {
  console.log(`Cleaned up ${cleanedTimelines} expired media timeline(s).`);
}

const app = new Hono();
const port = getPort();

app.use("*", async (c, next) => {
  const startedAt = Date.now();
  await next();
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - startedAt}ms`);
});

app.onError((err, c) => {
  console.error(err);

  return c.json(
    {
      ok: false,
      status: "error",
      error: "Internal server error",
    },
    500,
  );
});

app.route("/", health);
app.route("/api/auth", createAuthRoutes(db));
app.use("/api/admin/*", requireAdmin(db));
app.use("/api/events/*", requireAdmin(db));
app.use("/api/media-timelines", requireAdmin(db));
app.use("/api/media-timelines/*", requireAdmin(db));
app.use("/api/event-templates", requireAdmin(db));
app.use("/api/event-templates/*", requireAdmin(db));
app.use("/api/message-receipts", requireAdmin(db));
app.use("/api/message-receipts/*", requireAdmin(db));
app.use("/api/notification-profiles", requireAdmin(db));
app.use("/api/notification-profiles/*", requireAdmin(db));
app.use("/api/integrations/jellyfin", requireAdmin(db));
app.use("/api/integrations/jellyfin/*", requireAdmin(db));
app.use("/api/integrations/steamreviews", requireAdmin(db));
app.use("/api/integrations/steamreviews/*", requireAdmin(db));
app.use("/api/tracked-media", requireAdmin(db));
app.use("/api/tracked-media/*", requireAdmin(db));
app.use("/api/bandwidth-automation", requireAdmin(db));
app.use("/api/bandwidth-automation/*", requireAdmin(db));
app.route("/api/events", createEventRoutes());
app.route("/api/media-timelines", createMediaTimelineRoutes(db));
app.route("/api/event-templates", createEventTemplateRoutes(db));
app.route("/api/message-receipts", createMessageReceiptRoutes(db));
app.route("/api/notification-profiles", createNotificationProfileRoutes(db));
app.route("/api/integrations/jellyfin", createJellyfinIntegrationRoutes(db));
app.route("/api/integrations/steamreviews", createSteamreviewsIntegrationRoutes(db));
app.route("/api/tracked-media", createTrackedMediaRoutes(db));
app.route("/api/bandwidth-automation", createBandwidthAutomationRoutes(bandwidthController));
app.route("/api", createAdminRoutes(db));
app.route(
  "/webhook",
  createWebhookRoutes(db, {
    onJellyfinWebhook: (payload) => bandwidthController.handleJellyfinWebhook(payload),
  }),
);

app.use("/*", serveStatic({ root: "./client/dist" }));

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json(
      {
        ok: false,
        status: "not_found",
        error: `No API route for ${c.req.method} ${c.req.path}`,
      },
      404,
    );
  }

  if (c.req.path.startsWith("/webhook/")) {
    return c.json(
      {
        ok: false,
        status: "not_found",
        error: `No webhook route for ${c.req.method} ${c.req.path}`,
      },
      404,
    );
  }

  try {
    const indexHtml = await Deno.readTextFile("./client/dist/index.html");
    return c.html(indexHtml);
  } catch {
    return c.json(
      {
        ok: false,
        status: "not_found",
        error: "Frontend build not found. Run deno task build:client.",
      },
      404,
    );
  }
});

if (!getSharedSecret()) {
  console.warn(
    "SHARED_SECRET is not set. Webhook requests are allowed without x-sms-secret.",
  );
}

Deno.serve({ hostname: "0.0.0.0", port }, app.fetch);

// Reconciles SABnzbd's speed limit right away when automation is on.
bandwidthController.start();

let shuttingDown = false;

/** Lets bandwidth automation finish what it is doing (at most 3 seconds) before exiting. */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  await Promise.race([
    bandwidthController.stop(),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  Deno.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(signal, () => void shutdown(signal));
  } catch {
    // Windows has no SIGTERM listener; Ctrl+C (SIGINT) still works there.
  }
}
