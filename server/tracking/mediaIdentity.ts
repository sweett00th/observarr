import type { LiveEvent } from "../events/eventBus.ts";

export type MediaIdentity = {
  mediaKey: string;
  mediaType: string | null;
  title: string;
  normalizedTitle: string;
  tmdbId: string | null;
  imdbId: string | null;
  tvdbId: string | null;
  thumbnailUrl: string | null;
};

export function identifyMedia(event: LiveEvent): MediaIdentity | null {
  const raw = isObject(event.rawPayload) ? event.rawPayload : {};
  const title = extractTitleFromDownloadName(raw) ||
    event.entityTitle ||
    pickString(raw, ["title", "subject", "name", "Name"]) ||
    pickNestedString(raw, [["movie", "title"], ["series", "title"], ["episode", "title"]]) ||
    (event.source === "sabnzbd" ? null : event.title);

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
    pickNestedString(raw, [["movie", "year"], ["series", "year"]]) ||
    extractYearFromDownloadName(raw);
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
    thumbnailUrl: pickThumbnailUrl(raw),
  };
}

function pickThumbnailUrl(data: Record<string, unknown>): string | null {
  const direct = pickString(data, [
    "thumbnail",
    "thumbnailUrl",
    "thumbnail_url",
    "poster",
    "posterUrl",
    "poster_url",
    "image",
    "imageUrl",
    "image_url",
    "primaryImage",
    "primaryImageUrl",
  ]);

  if (direct && isLikelyImageUrl(direct)) {
    return direct;
  }

  const nested = pickNestedString(data, [
    ["movie", "posterUrl"],
    ["movie", "remotePoster"],
    ["movie", "thumbnailUrl"],
    ["series", "posterUrl"],
    ["series", "remotePoster"],
    ["series", "thumbnailUrl"],
    ["media", "posterUrl"],
    ["media", "thumbnailUrl"],
  ]);

  if (nested && isLikelyImageUrl(nested)) {
    return nested;
  }

  const images = findImageArray(data);
  const image = images.find((item) =>
    ["poster", "cover", "primary"].includes(String(item.coverType || item.type || "").toLowerCase())
  ) || images[0];
  const imageUrl = image ? pickString(image, ["remoteUrl", "url", "imageUrl", "thumbnailUrl"]) : undefined;

  return imageUrl && isLikelyImageUrl(imageUrl) ? imageUrl : null;
}

function findImageArray(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates = [data["images"], isObject(data["movie"]) ? data["movie"].images : undefined, isObject(data["series"]) ? data["series"].images : undefined];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isObject);
    }
  }

  return [];
}

function isLikelyImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith("/");
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

function extractTitleFromDownloadName(data: Record<string, unknown>): string | null {
  const value = pickString(data, ["name", "filename", "jobName", "nzbName"]);

  if (!value) {
    return null;
  }

  const cleaned = value
    .replace(/\.(mkv|mp4|avi|nzb)$/i, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const markerMatch = cleaned.match(
    /^(.*?)(?:\s+(?:19|20)\d{2}|\s+S\d{1,2}E\d{1,2}|\s+(?:480p|720p|1080p|2160p|4k|bluray|web[- ]?dl|webrip|remux|hdtv)\b)/i,
  );
  const title = markerMatch?.[1]?.trim() || cleaned;

  if (!title || title.length < 2) {
    return null;
  }

  return title;
}

function extractYearFromDownloadName(data: Record<string, unknown>): string | null {
  const value = pickString(data, ["name", "filename", "jobName", "nzbName", "title"]);
  const match = value?.match(/\b((?:19|20)\d{2})\b/);
  return match?.[1] ?? null;
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
