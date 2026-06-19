import type { Database } from "../db/index.ts";
import { firstRow } from "../db/index.ts";
import type { LiveEvent } from "../events/eventBus.ts";
import { identifyMedia } from "./mediaIdentity.ts";

export type TrackedMedia = {
  id: number;
  mediaKey: string;
  mediaType: string | null;
  title: string;
  source: string | null;
  status: string;
  createdFromEventId: string | null;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
};

export type TrackedMediaEvent = {
  id: number;
  trackedMediaId: number;
  liveEventId: string | null;
  timestamp: string;
  source: string;
  eventType: string;
  severity: string;
  title: string;
  message: string;
  rawPayload: unknown;
  createdAt: string;
};

export function listTrackedMedia(db: Database): TrackedMedia[] {
  return [...db.query(`
    SELECT tm.id, tm.media_key, tm.media_type, tm.title, tm.source, tm.status,
      tm.created_from_event_id, tm.created_at, tm.updated_at,
      COUNT(tme.id) AS event_count,
      MIN(tme.timestamp) AS first_event_at,
      MAX(tme.timestamp) AS last_event_at
    FROM tracked_media tm
    LEFT JOIN tracked_media_events tme ON tme.tracked_media_id = tm.id
    GROUP BY tm.id
    ORDER BY COALESCE(MAX(tme.timestamp), tm.created_at) DESC
  `)].map(mapTrackedMedia);
}

export function getTrackedMedia(db: Database, id: number): TrackedMedia | null {
  const row = firstRow(db, `
    SELECT tm.id, tm.media_key, tm.media_type, tm.title, tm.source, tm.status,
      tm.created_from_event_id, tm.created_at, tm.updated_at,
      COUNT(tme.id) AS event_count,
      MIN(tme.timestamp) AS first_event_at,
      MAX(tme.timestamp) AS last_event_at
    FROM tracked_media tm
    LEFT JOIN tracked_media_events tme ON tme.tracked_media_id = tm.id
    WHERE tm.id = ?
    GROUP BY tm.id
  `, [id]);

  return row ? mapTrackedMedia(row) : null;
}

export function listTimelineEvents(db: Database, trackedMediaId: number): TrackedMediaEvent[] {
  return [...db.query(`
    SELECT id, tracked_media_id, live_event_id, timestamp, source, event_type,
      severity, title, message, raw_payload, created_at
    FROM tracked_media_events
    WHERE tracked_media_id = ?
    ORDER BY timestamp ASC, id ASC
  `, [trackedMediaId])].map(mapTimelineEvent);
}

export function trackMediaFromEvent(db: Database, event: LiveEvent): TrackedMedia | null {
  const identity = identifyMedia(event);

  if (!identity) {
    return null;
  }

  const now = new Date().toISOString();
  db.query(`
    INSERT INTO tracked_media (
      media_key, media_type, title, source, status, created_from_event_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'tracking', ?, ?, ?)
    ON CONFLICT(media_key) DO UPDATE SET
      title = excluded.title,
      media_type = COALESCE(excluded.media_type, tracked_media.media_type),
      updated_at = excluded.updated_at
  `, [
    identity.mediaKey,
    identity.mediaType,
    identity.title,
    event.source,
    event.id,
    now,
    now,
  ]);

  const row = firstRow(db, "SELECT id FROM tracked_media WHERE media_key = ?", [identity.mediaKey]);
  const trackedMediaId = row ? Number(row[0]) : null;

  if (!trackedMediaId) {
    return null;
  }

  persistTimelineEvent(db, trackedMediaId, event);
  return getTrackedMedia(db, trackedMediaId);
}

export function persistEventForTrackedMedia(db: Database, event: LiveEvent): void {
  const identity = identifyMedia(event);

  if (!identity) {
    return;
  }

  const row = firstRow(db, "SELECT id FROM tracked_media WHERE media_key = ?", [identity.mediaKey]);

  if (!row) {
    return;
  }

  persistTimelineEvent(db, Number(row[0]), event);
}

function persistTimelineEvent(db: Database, trackedMediaId: number, event: LiveEvent): void {
  const existing = firstRow(
    db,
    "SELECT id FROM tracked_media_events WHERE live_event_id = ? AND tracked_media_id = ?",
    [event.id, trackedMediaId],
  );

  if (existing) {
    return;
  }

  const now = new Date().toISOString();
  db.query(`
    INSERT INTO tracked_media_events (
      tracked_media_id, live_event_id, timestamp, source, event_type,
      severity, title, message, raw_payload, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    trackedMediaId,
    event.id,
    event.timestamp,
    event.source,
    event.eventType,
    event.severity,
    event.title,
    event.message,
    JSON.stringify(event.rawPayload ?? event.rawSummary ?? null),
    now,
  ]);
  db.query("UPDATE tracked_media SET updated_at = ? WHERE id = ?", [now, trackedMediaId]);
}

function mapTrackedMedia(row: unknown[]): TrackedMedia {
  return {
    id: Number(row[0]),
    mediaKey: String(row[1]),
    mediaType: row[2] === null ? null : String(row[2]),
    title: String(row[3]),
    source: row[4] === null ? null : String(row[4]),
    status: String(row[5]),
    createdFromEventId: row[6] === null ? null : String(row[6]),
    createdAt: String(row[7]),
    updatedAt: String(row[8]),
    eventCount: Number(row[9]),
    firstEventAt: row[10] === null ? null : String(row[10]),
    lastEventAt: row[11] === null ? null : String(row[11]),
  };
}

function mapTimelineEvent(row: unknown[]): TrackedMediaEvent {
  return {
    id: Number(row[0]),
    trackedMediaId: Number(row[1]),
    liveEventId: row[2] === null ? null : String(row[2]),
    timestamp: String(row[3]),
    source: String(row[4]),
    eventType: String(row[5]),
    severity: String(row[6]),
    title: String(row[7]),
    message: String(row[8]),
    rawPayload: row[9] ? JSON.parse(String(row[9])) : null,
    createdAt: String(row[10]),
  };
}
