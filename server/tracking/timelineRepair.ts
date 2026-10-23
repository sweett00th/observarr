import type { DB } from "sqlite";
import { type EventSourceName, type LiveEvent, normalizeWebhookEvent } from "../events/eventBus.ts";
import {
  belongsOnTimeline,
  identifyMedia,
  type MediaIdentity,
  shouldUpdateCanonicalTitle,
} from "./mediaIdentity.ts";

export type TimelineRepairSummary = {
  eventsRemoved: number;
  timelinesRebuilt: number;
  timelinesMerged: number;
  emptyTimelinesRemoved: number;
};

/**
 * One-time cleanup (migration 10) of timelines built before Jellyfin events were identified
 * properly. Until then, Jellyfin sign-ins and sessions all landed on one "Jellyfin event"
 * timeline, and each series' episodes piled onto a timeline named after the last episode played,
 * apart from the series' own timeline. This:
 * 1. removes the events that don't belong on a timeline (see belongsOnTimeline),
 * 2. re-derives each timeline that holds Jellyfin episode or season events, or lost events in
 *    step 1, by replaying its remaining events under the current rules (an episode's timeline
 *    becomes its series'),
 * 3. folds each of those into an older timeline of the same movie or series, if there is one,
 *    moving its events, subscriptions and SMS dedupe keys,
 * 4. removes timelines that step 1 left empty.
 */
export function repairJellyfinTimelines(db: DB): TimelineRepairSummary {
  const summary: TimelineRepairSummary = {
    eventsRemoved: 0,
    timelinesRebuilt: 0,
    timelinesMerged: 0,
    emptyTimelinesRemoved: 0,
  };
  const now = new Date().toISOString();
  const emptied = new Set<number>();

  for (
    const [id, mediaItemId, eventType] of db.query(
      "SELECT id, media_item_id, event_type FROM media_events WHERE source = 'jellyfin'",
    )
  ) {
    if (!belongsOnTimeline("jellyfin", String(eventType))) {
      db.query("DELETE FROM media_events WHERE id = ?", [Number(id)]);
      emptied.add(Number(mediaItemId));
      summary.eventsRemoved += 1;
    }
  }

  const rebuilt: number[] = [];
  const rekeys = new Map<number, string>();
  const candidates = new Set(emptied);

  for (
    const [mediaItemId] of db.query(
      "SELECT DISTINCT media_item_id FROM media_events WHERE source = 'jellyfin'",
    )
  ) {
    candidates.add(Number(mediaItemId));
  }

  for (const id of [...candidates].sort((left, right) => left - right)) {
    const events = timelineEvents(db, id);

    if (!emptied.has(id) && !events.some(isJellyfinEpisodeOrSeason)) {
      continue;
    }

    const replayed = replay(events);

    if (!replayed) {
      continue;
    }

    db.query(
      `
      UPDATE media_items
      SET title = ?, normalized_title = ?, media_type = ?, tmdb_id = ?, imdb_id = ?, tvdb_id = ?,
        thumbnail_url = COALESCE(?, thumbnail_url), jellyfin_item_id = ?, jellyfin_series_id = ?,
        year = COALESCE(?, year), updated_at = ?
      WHERE id = ?
    `,
      [
        replayed.identity.title,
        replayed.identity.normalizedTitle,
        replayed.identity.mediaType,
        replayed.identity.tmdbId,
        replayed.identity.imdbId,
        replayed.identity.tvdbId,
        replayed.identity.thumbnailUrl,
        replayed.identity.jellyfinItemId,
        replayed.identity.jellyfinSeriesId,
        replayed.identity.year,
        now,
        id,
      ],
    );

    // A key no event produces any more ("title:jellyfin-event", "episode:<an episode's id>") is
    // replaced with the one its events produce now, once the merges below have freed it.
    const [currentKey] = firstRow(db, "SELECT media_key FROM media_items WHERE id = ?", [id]) ??
      [];
    if (!replayed.keys.has(String(currentKey))) {
      rekeys.set(id, replayed.latestKey);
    }

    rebuilt.push(id);
    summary.timelinesRebuilt += 1;
  }

  const touched = new Set<number>(rebuilt);

  for (const id of rebuilt) {
    let keepId = id;
    let twinId = findSameMedia(db, keepId);

    while (twinId !== null) {
      const dropId = Math.max(keepId, twinId);
      keepId = Math.min(keepId, twinId);
      mergeTimeline(db, keepId, dropId, now);
      touched.delete(dropId);
      touched.add(keepId);
      summary.timelinesMerged += 1;
      twinId = findSameMedia(db, keepId);
    }
  }

  for (const [id, key] of rekeys) {
    db.query("UPDATE OR IGNORE media_items SET media_key = ? WHERE id = ?", [key, id]);
  }

  // Subscriptions keep a copy of their timeline's title and ids for the profile page and for
  // matching. Copy the repaired ones, so an old episode TMDB id can't match an unrelated show.
  for (const id of touched) {
    const item = firstRow(
      db,
      "SELECT title, media_type, tmdb_id, year, jellyfin_series_id FROM media_items WHERE id = ?",
      [id],
    );

    if (item) {
      db.query(
        `
        UPDATE OR IGNORE profile_media_interests
        SET title = ?, media_type = ?, tmdb_id = ?, year = ?, jellyfin_series_id = ?, updated_at = ?
        WHERE media_item_id = ?
      `,
        [
          ...(item as Array<string | null>),
          now,
          id,
        ],
      );
    }
  }

  for (const id of emptied) {
    const exists = firstRow(db, "SELECT 1 FROM media_items WHERE id = ?", [id]);
    const hasEvents = firstRow(db, "SELECT 1 FROM media_events WHERE media_item_id = ? LIMIT 1", [
      id,
    ]);

    if (exists && !hasEvents) {
      db.query("DELETE FROM media_items WHERE id = ?", [id]);
      summary.emptyTimelinesRemoved += 1;
    }
  }

  return summary;
}

function timelineEvents(db: DB, mediaItemId: number): LiveEvent[] {
  return [...db.query(
    `
    SELECT live_event_id, timestamp, source, raw_payload
    FROM media_events
    WHERE media_item_id = ?
    ORDER BY timestamp ASC, id ASC
  `,
    [mediaItemId],
  )].map(([liveEventId, timestamp, source, rawPayload]) => ({
    id: String(liveEventId ?? ""),
    timestamp: String(timestamp),
    ...normalizeWebhookEvent(source as EventSourceName, parseJson(rawPayload)),
  }));
}

function isJellyfinEpisodeOrSeason(event: LiveEvent): boolean {
  const raw = event.rawPayload as Record<string, unknown> | null;
  const itemType = String(raw?.ItemType ?? raw?.itemType ?? "").toLowerCase();
  return event.source === "jellyfin" && (itemType === "episode" || itemType === "season");
}

/**
 * What the timeline's row would hold had its events arrived under the current rules, with every
 * key those events produce and the latest one.
 */
function replay(
  events: LiveEvent[],
): { identity: MediaIdentity; keys: Set<string>; latestKey: string } | null {
  let current: MediaIdentity | null = null;
  const keys = new Set<string>();
  let latestKey = "";

  for (const event of events) {
    const identity = identifyMedia(event);

    if (!identity) {
      continue;
    }

    keys.add(identity.mediaKey);
    latestKey = identity.mediaKey;

    if (!current) {
      current = { ...identity };
      continue;
    }

    // As updateMediaMetadata does: a later title may replace the name; later ids win.
    if (shouldUpdateCanonicalTitle(current.title, identity.title, event.source)) {
      current.title = identity.title;
      current.normalizedTitle = identity.normalizedTitle;
    }

    current.mediaType = identity.mediaType ?? current.mediaType;
    current.tmdbId = identity.tmdbId ?? current.tmdbId;
    current.imdbId = identity.imdbId ?? current.imdbId;
    current.tvdbId = identity.tvdbId ?? current.tvdbId;
    current.thumbnailUrl = identity.thumbnailUrl ?? current.thumbnailUrl;
    current.jellyfinItemId = identity.jellyfinItemId ?? current.jellyfinItemId;
    current.jellyfinSeriesId = identity.jellyfinSeriesId ?? current.jellyfinSeriesId;
    current.year = identity.year ?? current.year;
  }

  return current ? { identity: current, keys, latestKey } : null;
}

/**
 * Another timeline of the same movie or series: the same TMDB id or Jellyfin series, or, for a
 * series, the same title with no Jellyfin series or year saying otherwise (Sonarr's series
 * timelines carry neither id). Movies never match by title alone: remakes share titles, and
 * Jellyfin's movie events carry no year to tell them apart.
 */
function findSameMedia(db: DB, id: number): number | null {
  const item = firstRow(
    db,
    `
    SELECT media_type, normalized_title, tmdb_id, jellyfin_series_id, year
    FROM media_items WHERE id = ?
  `,
    [id],
  );

  if (!item || (item[0] !== "series" && item[0] !== "movie")) {
    return null;
  }

  const [mediaType, normalizedTitle, tmdbId, jellyfinSeriesId, year] = item as Array<
    string | null
  >;
  const twin = firstRow(
    db,
    `
    SELECT id FROM media_items
    WHERE id <> ? AND media_type = ? AND (
      tmdb_id = ?
      OR jellyfin_series_id = ?
      OR (
        media_type = 'series'
        AND normalized_title = ?
        AND (jellyfin_series_id IS NULL OR ? IS NULL OR jellyfin_series_id = ?)
        AND (year IS NULL OR ? IS NULL OR year = ?)
      )
    )
    ORDER BY id
    LIMIT 1
  `,
    [
      id,
      mediaType,
      tmdbId,
      jellyfinSeriesId,
      normalizedTitle,
      jellyfinSeriesId,
      jellyfinSeriesId,
      year,
      year,
    ],
  );

  return twin ? Number(twin[0]) : null;
}

/** Folds timeline `dropId` into `keepId`: its events, subscriptions, dedupe keys and missing ids. */
function mergeTimeline(db: DB, keepId: number, dropId: number, now: string): void {
  const drop = firstRow(
    db,
    `
    SELECT tmdb_id, imdb_id, tvdb_id, thumbnail_url, jellyfin_item_id, jellyfin_series_id, year
    FROM media_items WHERE id = ?
  `,
    [dropId],
  ) as Array<string | null> | null;

  if (!drop) {
    return;
  }

  db.query("UPDATE media_events SET media_item_id = ? WHERE media_item_id = ?", [keepId, dropId]);
  // Lifecycle stays the kept timeline's: inheriting an expired cleanup_after would delete it.
  db.query(
    `
    UPDATE media_items
    SET tmdb_id = COALESCE(tmdb_id, ?), imdb_id = COALESCE(imdb_id, ?),
      tvdb_id = COALESCE(tvdb_id, ?), thumbnail_url = COALESCE(thumbnail_url, ?),
      jellyfin_item_id = COALESCE(jellyfin_item_id, ?),
      jellyfin_series_id = COALESCE(jellyfin_series_id, ?), year = COALESCE(year, ?),
      updated_at = ?
    WHERE id = ?
  `,
    [...drop, now, keepId],
  );

  for (
    const [interestId, profileId, enabled] of db.query(
      "SELECT id, profile_id, enabled FROM profile_media_interests WHERE media_item_id = ?",
      [dropId],
    )
  ) {
    const existing = firstRow(
      db,
      "SELECT id FROM profile_media_interests WHERE profile_id = ? AND media_item_id = ?",
      [Number(profileId), keepId],
    );

    if (existing) {
      db.query("UPDATE profile_media_interests SET enabled = MAX(enabled, ?) WHERE id = ?", [
        Number(enabled),
        Number(existing[0]),
      ]);
      db.query("DELETE FROM profile_media_interests WHERE id = ?", [Number(interestId)]);
    } else {
      db.query("UPDATE profile_media_interests SET media_item_id = ? WHERE id = ?", [
        keepId,
        Number(interestId),
      ]);
    }
  }

  // "media:<id>" or "media:<id>:season:<n>": a text already sent about the dropped timeline
  // still counts against the kept one.
  db.query(
    `
    UPDATE message_receipts
    SET media_scope_key = ? || substr(media_scope_key, ?)
    WHERE media_scope_key = ? OR media_scope_key LIKE ?
  `,
    [`media:${keepId}`, `media:${dropId}`.length + 1, `media:${dropId}`, `media:${dropId}:%`],
  );
  db.query("DELETE FROM media_items WHERE id = ?", [dropId]);
}

// db/index.ts has one too, but it runs migrations, which import this file: a cycle.
function firstRow(
  db: DB,
  sql: string,
  params: Array<number | string | null>,
): unknown[] | null {
  for (const row of db.query(sql, params)) {
    return row;
  }

  return null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
