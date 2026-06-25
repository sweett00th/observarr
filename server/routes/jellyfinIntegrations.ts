import { Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import {
  JellyfinConfigurationError,
  JellyfinRequestError,
} from "../integrations/jellyfin/client.ts";
import { importJellyfinUsers } from "../integrations/jellyfin/importUsers.ts";
import { isJellyfinConfigured } from "../lib/config.ts";

export function createJellyfinIntegrationRoutes(db: Database): Hono {
  const jellyfin = new Hono();

  jellyfin.get("/status", (c) => {
    return c.json({
      ok: true,
      configured: isJellyfinConfigured(),
    });
  });

  jellyfin.post("/import-users", async (c) => {
    try {
      const summary = await importJellyfinUsers(db);
      return c.json({
        ok: true,
        summary,
      });
    } catch (error) {
      if (error instanceof JellyfinConfigurationError) {
        return c.json({ ok: false, status: "not_configured", error: error.message }, 400);
      }

      if (error instanceof JellyfinRequestError) {
        return c.json({ ok: false, status: "bad_gateway", error: error.message }, 502);
      }

      throw error;
    }
  });

  return jellyfin;
}
