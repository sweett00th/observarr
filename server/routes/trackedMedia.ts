import { Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import {
  getMediaTimeline,
  getMediaTimelineByLiveEventId,
  listMediaTimelineEvents,
  listMediaTimelines,
} from "../tracking/mediaTimelines.ts";

type FromEventPayload = {
  eventId?: unknown;
};

export function createTrackedMediaRoutes(db: Database): Hono {
  const tracked = new Hono();

  tracked.get("/", (c) => {
    return c.json({
      ok: true,
      media: listMediaTimelines(db),
    });
  });

  tracked.delete("/", async (c) => {
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
    const uniqueIds = [...new Set(ids)];

    if (uniqueIds.length === 0) {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "At least one media timeline id is required",
        },
        400,
      );
    }

    for (const id of uniqueIds) {
      db.query("DELETE FROM media_items WHERE id = ?", [id]);
    }

    return c.json({
      ok: true,
      deleted: uniqueIds.length,
    });
  });

  tracked.post("/from-event", async (c) => {
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

  tracked.get("/:id", (c) => {
    const id = Number(c.req.param("id"));

    if (!Number.isInteger(id) || id < 1) {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "Invalid tracked media id",
        },
        400,
      );
    }

    const media = getMediaTimeline(db, id);

    if (!media) {
      return c.json(
        {
          ok: false,
          status: "not_found",
          error: "Tracked media not found",
        },
        404,
      );
    }

    return c.json({
      ok: true,
      media,
      events: listMediaTimelineEvents(db, id),
    });
  });

  return tracked;
}
