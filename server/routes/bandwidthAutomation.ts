import { type Context, Hono } from "@hono/hono";
import { BandwidthConfigurationError, type BandwidthController } from "../bandwidth/controller.ts";
import { parseSettingsPatch } from "../bandwidth/settings.ts";

const maxBodyBytes = 16 * 1024;

/** Mounted at /api/bandwidth-automation behind requireAdmin. Never returns URLs or API keys. */
export function createBandwidthAutomationRoutes(controller: BandwidthController): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    return c.json({ ok: true, ...controller.getStatus() });
  });

  routes.patch("/settings", async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) {
      return c.json({ ok: false, status: body.status, error: body.error }, body.code);
    }

    const parsed = parseSettingsPatch(body.value);
    if (!parsed.ok) {
      return c.json({ ok: false, status: "bad_request", error: parsed.error }, 400);
    }

    try {
      const status = await controller.updateSettings(parsed.patch);
      return c.json({ ok: true, ...status });
    } catch (error) {
      if (error instanceof BandwidthConfigurationError) {
        return c.json({ ok: false, status: "not_configured", error: error.message }, 409);
      }

      throw error;
    }
  });

  routes.post("/reconcile", async (c) => {
    const outcome = await controller.reconcileNow();
    return c.json({ ok: true, outcome, ...controller.getStatus() });
  });

  return routes;
}

type JsonBody =
  | { ok: true; value: unknown }
  | { ok: false; code: 400 | 413 | 415; status: string; error: string };

async function readJsonBody(c: Context): Promise<JsonBody> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      code: 415,
      status: "unsupported_media_type",
      error: "Expected application/json",
    };
  }

  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > maxBodyBytes) {
    return { ok: false, code: 413, status: "payload_too_large", error: "Body is too large" };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: 400, status: "bad_request", error: "Invalid JSON body" };
  }
}
