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
  mergeProfiles,
  replacePreferences,
  updateProfile,
  ValidationError,
} from "../notifications/profiles.ts";
import { listReceiptsForProfilePhone } from "../notifications/receiptService.ts";
import {
  getProfilePhoneNumber,
  sendPendingWelcomeOptInMessages,
  sendWelcomeOptInMessage,
} from "../notifications/phoneNumbers.ts";

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

  // Folds another profile (e.g. one imported from Steam) into this one (e.g. imported from
  // Jellyfin): the same person, known to two services. The other profile is deleted.
  profiles.post("/:id/merge", async (c) => {
    const id = parseProfileId(c.req.param("id"));
    if (!id) {
      return c.json(badProfileId(), 400);
    }

    const payload = await readJson(c);
    if (!payload.ok) {
      return c.json(payload.body, 400);
    }

    const sourceId = payload.value.sourceProfileId;
    if (typeof sourceId !== "number" || !Number.isInteger(sourceId) || sourceId <= 0) {
      return c.json({
        ok: false,
        status: "bad_request",
        error: "sourceProfileId must be a notification profile id",
      }, 400);
    }

    try {
      const merged = mergeProfiles(db, id, sourceId);
      if (!merged) {
        return c.json(
          { ok: false, status: "not_found", error: "Notification profile not found" },
          404,
        );
      }
      console.log(JSON.stringify({
        event: "notification_profile.merged",
        at: new Date().toISOString(),
        profileId: id,
        mergedProfileId: sourceId,
        ...merged.summary,
      }));
      return c.json({ ok: true, ...merged });
    } catch (error) {
      return profileErrorResponse(c, error);
    }
  });

  profiles.post("/:id/phone-numbers/:phoneId/send-opt-in", async (c) => {
    const id = parseProfileId(c.req.param("id"));
    const phoneId = parseProfileId(c.req.param("phoneId"));
    if (!id || !phoneId) {
      return c.json({
        ok: false,
        status: "bad_request",
        error: "Invalid profile or phone number id",
      }, 400);
    }

    try {
      const phone = await sendWelcomeOptInMessage(db, id, phoneId);
      return c.json({ ok: true, phone });
    } catch (error) {
      return profileErrorResponse(c, error);
    }
  });

  profiles.post("/:id/phone-numbers/send-pending-opt-ins", async (c) => {
    const id = parseProfileId(c.req.param("id"));
    if (!id) {
      return c.json(badProfileId(), 400);
    }

    try {
      const result = await sendPendingWelcomeOptInMessages(db, id);
      return c.json({ ok: true, ...result });
    } catch (error) {
      return profileErrorResponse(c, error);
    }
  });

  profiles.get("/:id/phone-numbers/:phoneId/receipts", (c) => {
    const id = parseProfileId(c.req.param("id"));
    const phoneId = parseProfileId(c.req.param("phoneId"));
    if (!id || !phoneId) {
      return c.json({
        ok: false,
        status: "bad_request",
        error: "Invalid profile or phone number id",
      }, 400);
    }
    if (!getProfilePhoneNumber(db, id, phoneId)) {
      return c.json({ ok: false, status: "not_found", error: "Phone number not found" }, 404);
    }
    return c.json({ ok: true, receipts: listReceiptsForProfilePhone(db, id, phoneId, 50) });
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
