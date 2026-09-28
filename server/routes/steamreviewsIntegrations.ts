import { Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import {
  SteamreviewsConfigurationError,
  SteamreviewsRequestError,
} from "../integrations/steamreviews/client.ts";
import { importSteamUsers } from "../integrations/steamreviews/importUsers.ts";
import { isSteamreviewsConfigured } from "../lib/config.ts";

export function createSteamreviewsIntegrationRoutes(db: Database): Hono {
  const steamreviews = new Hono();

  steamreviews.get("/status", (c) => {
    return c.json({
      ok: true,
      configured: isSteamreviewsConfigured(),
    });
  });

  steamreviews.post("/import-users", async (c) => {
    try {
      const summary = await importSteamUsers(db);
      return c.json({
        ok: true,
        summary,
      });
    } catch (error) {
      if (error instanceof SteamreviewsConfigurationError) {
        return c.json({ ok: false, status: "not_configured", error: error.message }, 400);
      }

      if (error instanceof SteamreviewsRequestError) {
        return c.json({ ok: false, status: "bad_gateway", error: error.message }, 502);
      }

      throw error;
    }
  });

  return steamreviews;
}
