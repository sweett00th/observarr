import type { Database } from "../db/index.ts";
import { firstRow } from "../db/index.ts";
import type { LiveEvent } from "../events/eventBus.ts";
import type { MediaTimeline } from "../tracking/mediaTimelines.ts";

export type ProfileMediaInterest = {
  id: number;
  profileId: number;
  mediaItemId: number | null;
  mediaType: string | null;
  tmdbId: string | null;
  title: string;
  year: string | null;
  jellyfinSeriesId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MediaInterestTarget = {
  mediaItemId: number | null;
  mediaType: string | null;
  tmdbId: string | null;
  jellyfinSeriesId: string | null;
};

export type AutoSubscriptionResult = {
  matched: boolean;
  created: boolean;
  updated: boolean;
  profileId: number | null;
  mediaItemId: number | null;
  reason?: string;
};

export function subscribeMediaItemsToProfiles(
  db: Database,
  mediaItemIds: number[],
  profileIds: number[],
): { created: number; updated: number } {
  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const mediaItemId of mediaItemIds) {
    const mediaRow = firstRow(
      db,
      "SELECT media_type, tmdb_id, title, year, jellyfin_series_id FROM media_items WHERE id = ?",
      [mediaItemId],
    );
    if (!mediaRow) continue;

    const mediaType = nullableString(mediaRow[0]);
    const tmdbId = nullableString(mediaRow[1]);
    const title = String(mediaRow[2]);
    const year = nullableString(mediaRow[3]);
    const jellyfinSeriesId = nullableString(mediaRow[4]);

    for (const profileId of profileIds) {
      const existing = firstRow(
        db,
        "SELECT id FROM profile_media_interests WHERE profile_id = ? AND media_item_id = ? LIMIT 1",
        [profileId, mediaItemId],
      );

      if (existing) {
        db.query(
          `UPDATE profile_media_interests
           SET media_type = COALESCE(?, media_type),
             tmdb_id = COALESCE(?, tmdb_id),
             title = CASE WHEN trim(?) <> '' THEN ? ELSE title END,
             year = COALESCE(?, year),
             jellyfin_series_id = COALESCE(?, jellyfin_series_id),
             enabled = 1,
             updated_at = ?
           WHERE id = ?`,
          [mediaType, tmdbId, title, title, year, jellyfinSeriesId, now, Number(existing[0])],
        );
        updated++;
      } else {
        db.query(
          `INSERT INTO profile_media_interests (
            profile_id, media_item_id, media_type, tmdb_id, title, year,
            jellyfin_series_id, enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [profileId, mediaItemId, mediaType, tmdbId, title, year, jellyfinSeriesId, now, now],
        );
        created++;
      }
    }
  }

  return { created, updated };
}

export function listProfileMediaInterests(db: Database, profileId: number): ProfileMediaInterest[] {
  return [...db.query(
    `
    SELECT id, profile_id, media_item_id, media_type, tmdb_id, title, year,
      jellyfin_series_id, enabled, created_at, updated_at
    FROM profile_media_interests
    WHERE profile_id = ?
    ORDER BY lower(title) ASC, id ASC
  `,
    [profileId],
  )].map(mapInterest);
}

export function profileHasMediaInterest(
  db: Database,
  profileId: number,
  target: MediaInterestTarget | null,
): boolean {
  if (!target) return false;
  const clauses: string[] = [];
  const params: Array<string | number | null> = [profileId];

  if (target.mediaItemId) {
    clauses.push("media_item_id = ?");
    params.push(target.mediaItemId);
  }
  if (target.tmdbId) {
    clauses.push("tmdb_id = ?");
    params.push(target.tmdbId);
  }
  if (target.jellyfinSeriesId) {
    clauses.push("jellyfin_series_id = ?");
    params.push(target.jellyfinSeriesId);
  }

  if (clauses.length === 0) return false;
  const row = firstRow(
    db,
    `
    SELECT id FROM profile_media_interests
    WHERE profile_id = ? AND enabled = 1 AND (${clauses.join(" OR ")})
    LIMIT 1
  `,
    params,
  );
  return Boolean(row);
}

export function getMediaInterestTargetForItem(
  db: Database,
  mediaItemId: number | null | undefined,
): MediaInterestTarget | null {
  if (!mediaItemId) return null;
  const row = firstRow(
    db,
    `
    SELECT id, media_type, tmdb_id, jellyfin_series_id
    FROM media_items
    WHERE id = ?
  `,
    [mediaItemId],
  );
  if (!row) return null;
  return {
    mediaItemId: Number(row[0]),
    mediaType: nullableString(row[1]),
    tmdbId: nullableString(row[2]),
    jellyfinSeriesId: nullableString(row[3]),
  };
}

export function subscribeRequesterToSeerrMedia(
  db: Database,
  event: LiveEvent,
  media: MediaTimeline | null,
): AutoSubscriptionResult {
  if (event.source !== "seerr") {
    return {
      matched: false,
      created: false,
      updated: false,
      profileId: null,
      mediaItemId: null,
      reason: "not_seerr",
    };
  }

  if (!media) {
    return {
      matched: false,
      created: false,
      updated: false,
      profileId: null,
      mediaItemId: null,
      reason: "no_media",
    };
  }

  const raw = isObject(event.rawPayload) ? event.rawPayload : {};
  const username = pickNestedString(raw, [["request", "requestedBy_username"]]) ||
    pickString(raw, ["requestedBy_username", "requestedByUsername"]);
  const email = pickNestedString(raw, [["request", "requestedBy_email"]]) ||
    pickString(raw, ["requestedBy_email", "requestedByEmail"]);

  if (!username && !email) {
    return {
      matched: false,
      created: false,
      updated: false,
      profileId: null,
      mediaItemId: media.id,
      reason: "no_requester_identity",
    };
  }

  const profileId = findSeerrRequesterProfileId(db, username, email);

  if (!profileId) {
    return {
      matched: false,
      created: false,
      updated: false,
      profileId: null,
      mediaItemId: media.id,
      reason: "profile_not_found",
    };
  }

  const existing = findExistingInterest(db, profileId, media);
  const now = new Date().toISOString();

  if (existing) {
    db.query(
      `
      UPDATE profile_media_interests
      SET media_item_id = COALESCE(media_item_id, ?),
        media_type = COALESCE(?, media_type),
        tmdb_id = COALESCE(?, tmdb_id),
        title = CASE WHEN trim(?) <> '' THEN ? ELSE title END,
        year = COALESCE(?, year),
        jellyfin_series_id = COALESCE(?, jellyfin_series_id),
        updated_at = ?
      WHERE id = ?
    `,
      [
        media.id,
        media.mediaType,
        media.tmdbId,
        media.title,
        media.title,
        media.year,
        media.jellyfinSeriesId,
        now,
        existing.id,
      ],
    );
    return { matched: true, created: false, updated: true, profileId, mediaItemId: media.id };
  }

  db.query(
    `
    INSERT INTO profile_media_interests (
      profile_id, media_item_id, media_type, tmdb_id, title, year,
      jellyfin_series_id, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `,
    [
      profileId,
      media.id,
      media.mediaType,
      media.tmdbId,
      media.title,
      media.year,
      media.jellyfinSeriesId,
      now,
      now,
    ],
  );

  return { matched: true, created: true, updated: false, profileId, mediaItemId: media.id };
}

function findSeerrRequesterProfileId(
  db: Database,
  username: string | null,
  email: string | null,
): number | null {
  if (username) {
    const row = firstRow(
      db,
      `
      SELECT profile_id
      FROM profile_external_identities
      WHERE provider = 'seerr' AND username IS NOT NULL AND lower(username) = lower(?)
      ORDER BY id ASC
      LIMIT 1
    `,
      [username],
    );
    if (row) return Number(row[0]);
  }

  if (email) {
    const row = firstRow(
      db,
      `
      SELECT profile_id
      FROM profile_external_identities
      WHERE provider = 'seerr' AND email IS NOT NULL AND lower(email) = lower(?)
      ORDER BY id ASC
      LIMIT 1
    `,
      [email],
    );
    if (row) return Number(row[0]);
  }

  return null;
}

function findExistingInterest(
  db: Database,
  profileId: number,
  media: MediaTimeline,
): { id: number } | null {
  if (media.id) {
    const row = firstRow(
      db,
      "SELECT id FROM profile_media_interests WHERE profile_id = ? AND media_item_id = ? LIMIT 1",
      [profileId, media.id],
    );
    if (row) return { id: Number(row[0]) };
  }

  if (media.tmdbId) {
    const row = firstRow(
      db,
      `
      SELECT id FROM profile_media_interests
      WHERE profile_id = ? AND media_type IS ? AND tmdb_id = ?
      LIMIT 1
    `,
      [profileId, media.mediaType, media.tmdbId],
    );
    if (row) return { id: Number(row[0]) };
  }

  return null;
}

function mapInterest(row: unknown[]): ProfileMediaInterest {
  return {
    id: Number(row[0]),
    profileId: Number(row[1]),
    mediaItemId: row[2] === null ? null : Number(row[2]),
    mediaType: nullableString(row[3]),
    tmdbId: nullableString(row[4]),
    title: String(row[5]),
    year: nullableString(row[6]),
    jellyfinSeriesId: nullableString(row[7]),
    enabled: Number(row[8]) === 1,
    createdAt: String(row[9]),
    updatedAt: String(row[10]),
  };
}

function pickString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

function pickNestedString(data: Record<string, unknown>, paths: string[][]): string | null {
  for (const path of paths) {
    let current: unknown = data;

    for (const segment of path) {
      current = isObject(current) ? current[segment] : undefined;
    }

    if ((typeof current === "string" || typeof current === "number") && String(current).trim()) {
      return String(current).trim();
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
