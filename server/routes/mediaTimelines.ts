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

export function createMediaTimelineRoutes(db: Database): Hono {
  const media = new Hono();

  media.get("/", (c) => {
    return c.json({
      ok: true,
      media: listMediaTimelines(db),
    });
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
