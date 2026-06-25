import { type Context, Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import { notificationEventCatalog } from "../notifications/eventCatalog.ts";
import {
  ConflictError,
  createProfile,
  getAvatarFilePath,
  getProfile,
  getProfileDetails,
  listProfiles,
  replacePreferences,
  updateProfile,
  ValidationError,
} from "../notifications/profiles.ts";

export function createNotificationProfileRoutes(db: Database): Hono {
  const profiles = new Hono();

  profiles.get("/event-catalog", (c) => {
    return c.json({
      ok: true,
      catalog: notificationEventCatalog,
    });
  });

  profiles.get("/", (c) => {
    return c.json({
      ok: true,
      profiles: listProfiles(db, c.req.query("query") ?? ""),
    });
  });

  profiles.post("/", async (c) => {
    const payload = await readJson(c);
    if (!payload.ok) {
      return c.json(payload.body, 400);
    }

    try {
      return c.json({
        ok: true,
        profile: createProfile(db, payload.value),
      }, 201);
    } catch (error) {
      return profileErrorResponse(c, error);
    }
  });

  profiles.get("/:id/avatar", async (c) => {
    const id = parseProfileId(c.req.param("id"));
    if (!id) {
      return c.json(badProfileId(), 400);
    }

    const profile = getProfile(db, id);
    if (!profile?.avatarFilename || !profile.avatarContentType) {
      return c.json({ ok: false, status: "not_found", error: "Avatar not found" }, 404);
    }

    try {
      const file = await Deno.open(getAvatarFilePath(profile.avatarFilename), { read: true });
      return new Response(file.readable, {
        headers: {
          "Content-Type": profile.avatarContentType,
          "Cache-Control": "private, max-age=300",
        },
      });
    } catch {
      return c.json({ ok: false, status: "not_found", error: "Avatar not found" }, 404);
    }
  });

  profiles.get("/:id", (c) => {
    const id = parseProfileId(c.req.param("id"));
    if (!id) {
      return c.json(badProfileId(), 400);
    }

    const profile = getProfileDetails(db, id);
    if (!profile) {
      return c.json(
        { ok: false, status: "not_found", error: "Notification profile not found" },
        404,
      );
    }

    return c.json({ ok: true, profile });
  });

  profiles.patch("/:id", async (c) => {
    const id = parseProfileId(c.req.param("id"));
    if (!id) {
      return c.json(badProfileId(), 400);
    }

    const payload = await readJson(c);
    if (!payload.ok) {
      return c.json(payload.body, 400);
    }

    try {
      const profile = updateProfile(db, id, payload.value);
      if (!profile) {
        return c.json(
          { ok: false, status: "not_found", error: "Notification profile not found" },
          404,
        );
      }
      return c.json({ ok: true, profile });
    } catch (error) {
      return profileErrorResponse(c, error);
    }
  });

  profiles.put("/:id/preferences", async (c) => {
    const id = parseProfileId(c.req.param("id"));
    if (!id) {
      return c.json(badProfileId(), 400);
    }

    const payload = await readJson(c);
    if (!payload.ok) {
      return c.json(payload.body, 400);
    }

    const preferences = isObject(payload.value) ? payload.value.preferences : undefined;

    try {
      const profile = replacePreferences(db, id, Array.isArray(preferences) ? preferences : []);
      if (!profile) {
        return c.json(
          { ok: false, status: "not_found", error: "Notification profile not found" },
          404,
        );
      }
      return c.json({ ok: true, profile });
    } catch (error) {
      return profileErrorResponse(c, error);
    }
  });

  return profiles;
}

type JsonResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; body: { ok: false; status: "bad_request"; error: string } };

async function readJson(c: Context): Promise<JsonResult> {
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
    return {
      ok: false,
      body: { ok: false, status: "bad_request", error: "Expected JSON body" },
    };
  }
}

function profileErrorResponse(c: Context, error: unknown) {
  if (error instanceof ValidationError || error instanceof ConflictError) {
    if (error.status === 409) {
      return c.json({ ok: false, status: "conflict", error: error.message }, 409);
    }

    return c.json({ ok: false, status: "bad_request", error: error.message }, 400);
  }

  throw error;
}

function parseProfileId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function badProfileId() {
  return { ok: false, status: "bad_request", error: "Invalid notification profile id" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
