import { Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import { subscribeMediaItemsToProfiles } from "../notifications/mediaInterests.ts";
import {
  getMediaTimeline,
  getMediaTimelineByLiveEventId,
  listMediaTimelineEvents,
  listMediaTimelines,
} from "../tracking/mediaTimelines.ts";

type FromEventPayload = {
  eventId?: unknown;
};

export function createMediaTimelineRoutes(db: Database): Hono {
  const media = new Hono();

  media.get("/", (c) => {
    return c.json({
      ok: true,
      media: listMediaTimelines(db),
    });
  });

  media.delete("/", async (c) => {
    let payload: { ids?: unknown };

    try {
      payload = await c.req.json<{ ids?: unknown }>();
    } catch {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "Expected JSON body",
        },
        400,
      );
    }

    const ids = Array.isArray(payload.ids)
      ? payload.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    if (ids.length === 0) {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "At least one media timeline id is required",
        },
        400,
      );
    }

    for (const id of [...new Set(ids)]) {
      db.query("DELETE FROM media_items WHERE id = ?", [id]);
    }

    return c.json({
      ok: true,
      deleted: [...new Set(ids)].length,
    });
  });

  media.post("/subscribe", async (c) => {
    let payload: { mediaItemIds?: unknown; profileIds?: unknown };
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ ok: false, status: "bad_request", error: "Expected JSON body" }, 400);
    }

    const mediaItemIds = Array.isArray(payload.mediaItemIds)
      ? payload.mediaItemIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    const profileIds = Array.isArray(payload.profileIds)
      ? payload.profileIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    if (mediaItemIds.length === 0 || profileIds.length === 0) {
      return c.json({
        ok: false,
        status: "bad_request",
        error: "mediaItemIds and profileIds are required",
      }, 400);
    }

    const result = subscribeMediaItemsToProfiles(db, mediaItemIds, profileIds);
    return c.json({ ok: true, ...result });
  });

  media.post("/from-event", async (c) => {
    let payload: FromEventPayload;

    try {
      payload = await c.req.json<FromEventPayload>();
    } catch {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "Expected JSON body",
        },
        400,
      );
    }

    const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
    const media = eventId ? getMediaTimelineByLiveEventId(db, eventId) : null;

    if (!media) {
      return c.json(
        {
          ok: false,
          status: "not_found",
          error: "No media timeline was identified for this event",
        },
        404,
      );
    }

    return c.json({
      ok: true,
      media,
    });
  });

  media.get("/:id", (c) => {
    const id = Number(c.req.param("id"));

    if (!Number.isInteger(id) || id < 1) {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "Invalid media timeline id",
        },
        400,
      );
    }

    const item = getMediaTimeline(db, id);

    if (!item) {
      return c.json(
        {
          ok: false,
          status: "not_found",
          error: "Media timeline not found",
        },
        404,
      );
    }

    return c.json({
      ok: true,
      media: item,
      events: listMediaTimelineEvents(db, id),
    });
  });

  return media;
}
