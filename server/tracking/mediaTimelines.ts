import type { Database } from "../db/index.ts";
import { firstRow } from "../db/index.ts";
import type { LiveEvent } from "../events/eventBus.ts";
import { identifyMedia, normalizeSearchText } from "./mediaIdentity.ts";

const retentionDaysAfterAvailable = 14;

export type MediaTimeline = {
  id: number;
  mediaKey: string;
  title: string;
  normalizedTitle: string;
  mediaType: string | null;
  tmdbId: string | null;
  imdbId: string | null;
  tvdbId: string | null;
  thumbnailUrl: string | null;
  sourceFirstSeen: string | null;
  lifecycleStatus: string;
  availableAt: string | null;
  cleanupAfter: string | null;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
};

export type MediaTimelineEvent = {
  id: number;
  mediaItemId: number;
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

export function listMediaTimelines(db: Database): MediaTimeline[] {
  return [...db.query(`
    SELECT mi.id, mi.media_key, mi.title, mi.normalized_title, mi.media_type,
      mi.tmdb_id, mi.imdb_id, mi.tvdb_id, mi.thumbnail_url, mi.source_first_seen, mi.lifecycle_status,
      mi.available_at, mi.cleanup_after, mi.created_at, mi.updated_at,
      COUNT(me.id) AS event_count,
      MIN(me.timestamp) AS first_event_at,
      MAX(me.timestamp) AS last_event_at
    FROM media_items mi
    LEFT JOIN media_events me ON me.media_item_id = mi.id
    GROUP BY mi.id
    ORDER BY COALESCE(MAX(me.timestamp), mi.created_at) DESC
  `)].map(mapMediaTimeline);
}

export function getMediaTimeline(db: Database, id: number): MediaTimeline | null {
  const row = firstRow(db, `
    SELECT mi.id, mi.media_key, mi.title, mi.normalized_title, mi.media_type,
      mi.tmdb_id, mi.imdb_id, mi.tvdb_id, mi.thumbnail_url, mi.source_first_seen, mi.lifecycle_status,
      mi.available_at, mi.cleanup_after, mi.created_at, mi.updated_at,
      COUNT(me.id) AS event_count,
      MIN(me.timestamp) AS first_event_at,
      MAX(me.timestamp) AS last_event_at
    FROM media_items mi
    LEFT JOIN media_events me ON me.media_item_id = mi.id
    WHERE mi.id = ?
    GROUP BY mi.id
  `, [id]);

  return row ? mapMediaTimeline(row) : null;
}

export function getMediaTimelineByLiveEventId(db: Database, liveEventId: string): MediaTimeline | null {
  const row = firstRow(
    db,
    "SELECT media_item_id FROM media_events WHERE live_event_id = ? ORDER BY id DESC LIMIT 1",
    [liveEventId],
  );

  return row ? getMediaTimeline(db, Number(row[0])) : null;
}

export function listMediaTimelineEvents(db: Database, mediaItemId: number): MediaTimelineEvent[] {
  return [...db.query(`
    SELECT id, media_item_id, live_event_id, timestamp, source, event_type,
      severity, title, message, raw_payload, created_at
    FROM media_events
    WHERE media_item_id = ?
    ORDER BY timestamp ASC, id ASC
  `, [mediaItemId])].map(mapTimelineEvent);
}

export function persistMediaEvent(db: Database, event: LiveEvent): MediaTimeline | null {
  const mediaId = findOrCreateMediaTimeline(db, event);

  if (!mediaId) {
    return null;
  }

  persistTimelineEvent(db, mediaId, event);

  if (isMediaAvailableEvent(event)) {
    markMediaAvailable(db, mediaId, event.timestamp);
  }

  return getMediaTimeline(db, mediaId);
}

export function cleanupExpiredMediaTimelines(db: Database): number {
  const expiredIds = [...db.query(
    "SELECT id FROM media_items WHERE cleanup_after IS NOT NULL AND cleanup_after <= ?",
    [new Date().toISOString()],
  )].map((row) => Number(row[0]));

  for (const id of expiredIds) {
    db.query("DELETE FROM media_items WHERE id = ?", [id]);
  }

  return expiredIds.length;
}

export function startMediaTimelineCleanupJob(db: Database): number {
  return setInterval(() => {
    const deleted = cleanupExpiredMediaTimelines(db);

    if (deleted > 0) {
      console.log(`Cleaned up ${deleted} expired media timeline(s).`);
    }
  }, 24 * 60 * 60 * 1000);
}

function findOrCreateMediaTimeline(db: Database, event: LiveEvent): number | null {
  const identity = identifyMedia(event);

  if (!identity) {
    return findLooseMediaTimelineMatch(db, event);
  }

  const exact = firstRow(db, "SELECT id FROM media_items WHERE media_key = ?", [identity.mediaKey]);

  if (exact) {
    updateMediaMetadata(db, Number(exact[0]), event, identity);
    return Number(exact[0]);
  }

  const looseId = findLooseMediaTimelineMatch(db, event);

  if (looseId) {
    updateMediaMetadata(db, looseId, event, identity);
    return looseId;
  }

  const now = new Date().toISOString();
  db.query(`
    INSERT INTO media_items (
      media_key, title, normalized_title, media_type, tmdb_id, imdb_id, tvdb_id, thumbnail_url,
      source_first_seen, lifecycle_status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `, [
    identity.mediaKey,
    identity.title,
    identity.normalizedTitle,
    identity.mediaType,
    identity.tmdbId,
    identity.imdbId,
    identity.tvdbId,
    identity.thumbnailUrl,
    event.source,
    now,
    now,
  ]);

  const row = firstRow(db, "SELECT id FROM media_items WHERE media_key = ?", [identity.mediaKey]);
  return row ? Number(row[0]) : null;
}

function updateMediaMetadata(
  db: Database,
  mediaItemId: number,
  event: LiveEvent,
  identity: NonNullable<ReturnType<typeof identifyMedia>>,
): void {
  db.query(`
    UPDATE media_items
    SET title = ?,
      normalized_title = ?,
      media_type = COALESCE(?, media_type),
      tmdb_id = COALESCE(?, tmdb_id),
      imdb_id = COALESCE(?, imdb_id),
      tvdb_id = COALESCE(?, tvdb_id),
      thumbnail_url = COALESCE(?, thumbnail_url),
      source_first_seen = COALESCE(source_first_seen, ?),
      updated_at = ?
    WHERE id = ?
  `, [
    identity.title,
    identity.normalizedTitle,
    identity.mediaType,
    identity.tmdbId,
    identity.imdbId,
    identity.tvdbId,
    identity.thumbnailUrl,
    event.source,
    new Date().toISOString(),
    mediaItemId,
  ]);
}

function findLooseMediaTimelineMatch(db: Database, event: LiveEvent): number | null {
  const haystack = normalizeSearchText([
    event.title,
    event.message,
    event.entityTitle ?? "",
    JSON.stringify(event.rawPayload ?? event.rawSummary ?? null),
  ].join(" "));
  const candidates = [...db.query("SELECT id, normalized_title FROM media_items")].map((row) => ({
    id: Number(row[0]),
    title: String(row[1]),
  }));

  const match = candidates
    .filter((candidate) => candidate.title.length >= 3 && titleAppearsInText(candidate.title, haystack))
    .sort((left, right) => right.title.length - left.title.length)[0];

  return match?.id ?? null;
}

function persistTimelineEvent(db: Database, mediaItemId: number, event: LiveEvent): void {
  const existing = firstRow(
    db,
    "SELECT id FROM media_events WHERE live_event_id = ? AND media_item_id = ?",
    [event.id, mediaItemId],
  );

  if (existing) {
    return;
  }

  const now = new Date().toISOString();
  db.query(`
    INSERT INTO media_events (
      media_item_id, live_event_id, timestamp, source, event_type,
      severity, title, message, raw_payload, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    mediaItemId,
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
  db.query("UPDATE media_items SET updated_at = ? WHERE id = ?", [now, mediaItemId]);
}

function markMediaAvailable(db: Database, mediaItemId: number, timestamp: string): void {
  const availableAt = new Date(timestamp);
  const cleanupAfter = new Date(availableAt.getTime() + retentionDaysAfterAvailable * 24 * 60 * 60 * 1000);

  db.query(`
    UPDATE media_items
    SET lifecycle_status = 'available',
      available_at = ?,
      cleanup_after = ?,
      updated_at = ?
    WHERE id = ?
  `, [
    availableAt.toISOString(),
    cleanupAfter.toISOString(),
    new Date().toISOString(),
    mediaItemId,
  ]);
}

function isMediaAvailableEvent(event: LiveEvent): boolean {
  return normalizeSearchText(event.eventType).replaceAll(" ", "_") === "media_available";
}

function titleAppearsInText(title: string, text: string): boolean {
  if (text.includes(title)) {
    return true;
  }

  const words = title.split(" ").filter((word) => word.length > 2);
  return words.length > 0 && words.every((word) => text.includes(word));
}

function mapMediaTimeline(row: unknown[]): MediaTimeline {
  return {
    id: Number(row[0]),
    mediaKey: String(row[1]),
    title: String(row[2]),
    normalizedTitle: String(row[3]),
    mediaType: row[4] === null ? null : String(row[4]),
    tmdbId: row[5] === null ? null : String(row[5]),
    imdbId: row[6] === null ? null : String(row[6]),
    tvdbId: row[7] === null ? null : String(row[7]),
    thumbnailUrl: row[8] === null ? null : String(row[8]),
    sourceFirstSeen: row[9] === null ? null : String(row[9]),
    lifecycleStatus: String(row[10]),
    availableAt: row[11] === null ? null : String(row[11]),
    cleanupAfter: row[12] === null ? null : String(row[12]),
    createdAt: String(row[13]),
    updatedAt: String(row[14]),
    eventCount: Number(row[15]),
    firstEventAt: row[16] === null ? null : String(row[16]),
    lastEventAt: row[17] === null ? null : String(row[17]),
  };
}

function mapTimelineEvent(row: unknown[]): MediaTimelineEvent {
  return {
    id: Number(row[0]),
    mediaItemId: Number(row[1]),
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
