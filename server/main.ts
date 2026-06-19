import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/deno";
import { initializeDatabase } from "./db/index.ts";
import { requireAdmin } from "./middleware/auth.ts";
import { createAdminRoutes } from "./routes/admin.ts";
import { createAuthRoutes } from "./routes/auth.ts";
import { createEventRoutes } from "./routes/events.ts";
import health from "./routes/health.ts";
import { createMediaTimelineRoutes } from "./routes/mediaTimelines.ts";
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
app.use("/api/tracked-media", requireAdmin(db));
app.use("/api/tracked-media/*", requireAdmin(db));
app.route("/api/events", createEventRoutes());
app.route("/api/media-timelines", createMediaTimelineRoutes(db));
app.route("/api/tracked-media", createTrackedMediaRoutes(db));
app.route("/api", createAdminRoutes(db));
app.route("/webhook", createWebhookRoutes(db));

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
