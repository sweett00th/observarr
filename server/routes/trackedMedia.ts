import { Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import { eventBus } from "../events/eventBus.ts";
import {
  getTrackedMedia,
  listTimelineEvents,
  listTrackedMedia,
  trackMediaFromEvent,
} from "../tracking/trackedMedia.ts";

type TrackPayload = {
  eventId?: unknown;
};

export function createTrackedMediaRoutes(db: Database): Hono {
  const tracked = new Hono();

  tracked.get("/", (c) => {
    return c.json({
      ok: true,
      media: listTrackedMedia(db),
    });
  });

  tracked.post("/from-event", async (c) => {
    let payload: TrackPayload;

    try {
      payload = await c.req.json<TrackPayload>();
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
    const event = eventId ? eventBus.findById(eventId) : null;

    if (!event) {
      return c.json(
        {
          ok: false,
          status: "not_found",
          error: "Event is no longer available in the live buffer",
        },
        404,
      );
    }

    const media = trackMediaFromEvent(db, event);

    if (!media) {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "Could not identify media from this event",
        },
        400,
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

    const media = getTrackedMedia(db, id);

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
      events: listTimelineEvents(db, id),
    });
  });

  return tracked;
}
