import type { LiveEvent } from "../events/eventBus.ts";

export type MediaIdentity = {
  mediaKey: string;
  mediaType: string | null;
  title: string;
  normalizedTitle: string;
  tmdbId: string | null;
  imdbId: string | null;
  tvdbId: string | null;
};

export function identifyMedia(event: LiveEvent): MediaIdentity | null {
  const raw = isObject(event.rawPayload) ? event.rawPayload : {};
  const title = event.entityTitle ||
    pickString(raw, ["title", "subject", "name", "Name"]) ||
    pickNestedString(raw, [["movie", "title"], ["series", "title"], ["episode", "title"]]) ||
    event.title;

  if (!title || title.trim().length === 0) {
    return null;
  }

  const mediaType = event.entityType ||
    pickString(raw, ["entityType", "mediaType", "MediaType", "itemType"]) ||
    inferMediaType(event);
  const tmdbId = pickString(raw, ["tmdbId", "tmdb_id"]) ||
    pickNestedString(raw, [["movie", "tmdbId"], ["movie", "tmdb_id"]]) || null;
  const imdbId = pickString(raw, ["imdbId", "imdb_id"]) ||
    pickNestedString(raw, [["movie", "imdbId"], ["series", "imdbId"]]) || null;
  const tvdbId = pickString(raw, ["tvdbId", "tvdb_id"]) ||
    pickNestedString(raw, [["series", "tvdbId"], ["series", "tvdb_id"]]) || null;
  const externalId = tmdbId || imdbId || tvdbId || pickString(raw, ["guid"]);
  const year = pickString(raw, ["year", "releaseYear"]) ||
    pickNestedString(raw, [["movie", "year"], ["series", "year"]]);
  const keyParts = externalId
    ? [normalizeKey(mediaType || "media"), normalizeKey(externalId)]
    : ["title", normalizeKey(`${title} ${year || ""}`)];

  return {
    mediaKey: keyParts.join(":"),
    mediaType: mediaType || null,
    title,
    normalizedTitle: normalizeSearchText(title),
    tmdbId,
    imdbId,
    tvdbId,
  };
}

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function inferMediaType(event: LiveEvent): string | null {
  if (event.source === "radarr") {
    return "movie";
  }

  if (event.source === "sonarr") {
    return "series";
  }

  return null;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function pickString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];

    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
      return String(value).trim();
    }
  }

  return undefined;
}

function pickNestedString(data: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const path of paths) {
    let current: unknown = data;

    for (const segment of path) {
      current = isObject(current) ? current[segment] : undefined;
    }

    if ((typeof current === "string" || typeof current === "number") && String(current).trim()) {
      return String(current).trim();
    }
  }

  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
