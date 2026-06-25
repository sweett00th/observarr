import { type Context, Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import {
  catalogWithTemplateSummaries,
  getOrCreateEventTemplate,
  listEventTemplates,
  previewEventTemplate,
  resetEventTemplate,
  TemplateValidationError,
  updateEventTemplate,
} from "../notifications/eventTemplates.ts";

export function createEventTemplateRoutes(db: Database): Hono {
  const routes = new Hono();

  routes.get("/catalog", (c) => c.json({ ok: true, catalog: catalogWithTemplateSummaries(db) }));
  routes.get("/", (c) => c.json({ ok: true, templates: listEventTemplates(db) }));

  routes.get("/:source/:eventType", (c) => {
    try {
      return c.json({
        ok: true,
        template: getOrCreateEventTemplate(db, c.req.param("source"), c.req.param("eventType")),
      });
    } catch (error) {
      return templateErrorResponse(c, error);
    }
  });

  routes.patch("/:source/:eventType", async (c) => {
    const payload = await readJson(c);
    if (!payload.ok) return c.json(payload.body, 400);
    try {
      return c.json({
        ok: true,
        template: updateEventTemplate(
          db,
          c.req.param("source"),
          c.req.param("eventType"),
          payload.value,
        ),
      });
    } catch (error) {
      return templateErrorResponse(c, error);
    }
  });

  routes.post("/:source/:eventType/preview", async (c) => {
    const payload = await readJson(c, true);
    if (!payload.ok) return c.json(payload.body, 400);
    try {
      return c.json({
        ok: true,
        preview: previewEventTemplate(
          db,
          c.req.param("source"),
          c.req.param("eventType"),
          payload.value,
        ),
      });
    } catch (error) {
      return templateErrorResponse(c, error);
    }
  });

  routes.post("/:source/:eventType/reset", (c) => {
    try {
      return c.json({
        ok: true,
        template: resetEventTemplate(db, c.req.param("source"), c.req.param("eventType")),
      });
    } catch (error) {
      return templateErrorResponse(c, error);
    }
  });

  return routes;
}

type JsonResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; body: { ok: false; status: "bad_request"; error: string } };

async function readJson(c: Context, allowEmpty = false): Promise<JsonResult> {
  try {
    const value = await c.req.json<unknown>();
    if (!isObject(value)) {
      return {
        ok: false,
        body: { ok: false, status: "bad_request", error: "Expected JSON object" },
      };
    }
    return { ok: true, value };
  } catch {
    if (allowEmpty) return { ok: true, value: {} };
    return { ok: false, body: { ok: false, status: "bad_request", error: "Expected JSON body" } };
  }
}

function templateErrorResponse(c: Context, error: unknown) {
  if (error instanceof TemplateValidationError) {
    return c.json(
      { ok: false, status: "bad_request", error: error.message, errors: error.errors },
      400,
    );
  }
  throw error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
