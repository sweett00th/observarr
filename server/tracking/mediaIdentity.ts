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
  jellyfinItemId: string | null;
  jellyfinSeriesId: string | null;
  year: string | null;
};

/**
 * Jellyfin notification types that aren't about a piece of media (sign-ins, sessions, users,
 * plugins, server tasks) or that only bury a timeline (a progress ping every few seconds while
 * something plays, a user-data save after it). They still reach the Event Console and
 * notifications, but never a media timeline.
 */
export const jellyfinNonTimelineEventTypes = [
  "authenticationfailure",
  "authenticationsuccess",
  "sessionstart",
  "generic",
  "pendingrestart",
  "taskcompleted",
  "plugininstallationcancelled",
  "plugininstallationfailed",
  "plugininstalled",
  "plugininstalling",
  "pluginuninstalled",
  "pluginupdated",
  "usercreated",
  "userdeleted",
  "userlockedout",
  "userpasswordchanged",
  "userupdated",
  "playbackprogress",
  "userdatasaved",
];

export function belongsOnTimeline(source: string, eventType: string): boolean {
  return source !== "jellyfin" ||
    !jellyfinNonTimelineEventTypes.includes(eventType.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

export function identifyMedia(event: LiveEvent): MediaIdentity | null {
  const raw = isObject(event.rawPayload) ? event.rawPayload : {};
  const jellyfinSeries = identifyJellyfinSeries(event, raw);

  if (jellyfinSeries) {
    return jellyfinSeries;
  }

  // No fallback to event.title: when a payload names nothing, that is a placeholder ("Jellyfin
  // event"), and every untitled event would share one timeline under it.
  const title = extractTitleFromDownloadName(raw) ||
    event.entityTitle ||
    pickString(raw, ["title", "subject", "name", "Name"]) ||
    pickNestedString(raw, [["movie", "title"], ["series", "title"], ["episode", "title"], [
      "media",
      "title",
    ]]);

  if (!title || title.trim().length === 0) {
    return null;
  }

  const mediaType = event.entityType ||
    normalizeMediaType(
      pickString(raw, ["entityType", "mediaType", "MediaType", "itemType", "ItemType"]) ||
        pickNestedString(raw, [["media", "media_type"]]),
    ) ||
    inferMediaType(event);
  const tmdbId = pickString(raw, ["tmdbId", "tmdb_id"]) ||
    pickNestedString(raw, [["movie", "tmdbId"], ["movie", "tmdb_id"], ["media", "tmdbId"], [
      "media",
      "tmdb_id",
    ]]) ||
    pickString(raw, ["Provider_tmdb", "provider_tmdb"]) || null;
  const imdbId = pickString(raw, ["imdbId", "imdb_id"]) ||
    pickNestedString(raw, [["movie", "imdbId"], ["series", "imdbId"]]) ||
    pickString(raw, ["Provider_imdb", "provider_imdb"]) || null;
  const tvdbId = pickString(raw, ["tvdbId", "tvdb_id"]) ||
    pickNestedString(raw, [["series", "tvdbId"], ["series", "tvdb_id"]]) ||
    pickString(raw, ["Provider_tvdb", "provider_tvdb"]) || null;
  const jellyfinItemId = pickString(raw, ["ItemId", "itemId"]);
  const jellyfinSeriesId = pickString(raw, ["SeriesId", "seriesId"]) ||
    (mediaType === "series" ? jellyfinItemId : null);
  const externalId = tmdbId || imdbId || tvdbId || jellyfinSeriesId || jellyfinItemId ||
    pickString(raw, ["guid"]);
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
    jellyfinItemId: jellyfinItemId ?? null,
    jellyfinSeriesId: jellyfinSeriesId ?? null,
    year: year ?? null,
  };
}

/**
 * Jellyfin names an episode or season event after the episode ("Diary of a Chimpy Kid", "Season
 * 3") and gives that episode's own provider ids, but its timeline is the series'. Identify it as
 * the series, so the timeline keeps the series' name and is never keyed by an episode's ids.
 */
function identifyJellyfinSeries(
  event: LiveEvent,
  raw: Record<string, unknown>,
): MediaIdentity | null {
  const itemType = pickString(raw, ["ItemType", "itemType"])?.toLowerCase();
  const seriesName = pickString(raw, ["SeriesName", "seriesName"]);

  if (
    event.source !== "jellyfin" || (itemType !== "episode" && itemType !== "season") || !seriesName
  ) {
    return null;
  }

  const seriesId = pickString(raw, ["SeriesId", "seriesId"]) ?? null;

  return {
    mediaKey: seriesId ? `series:${normalizeKey(seriesId)}` : `title:${normalizeKey(seriesName)}`,
    mediaType: "series",
    title: seriesName,
    normalizedTitle: normalizeSearchText(seriesName),
    tmdbId: null,
    imdbId: null,
    tvdbId: null,
    thumbnailUrl: pickThumbnailUrl(raw),
    jellyfinItemId: seriesId,
    jellyfinSeriesId: seriesId,
    year: null,
  };
}

/** Whether an event's title should replace a timeline's current one. */
export function shouldUpdateCanonicalTitle(
  currentTitle: string,
  candidateTitle: string,
  source: string,
): boolean {
  if (!currentTitle) {
    return true;
  }

  if (source === "sabnzbd") {
    return false;
  }

  const noisyPrefixes = ["sabnzbd:", "radarr:", "sonarr:", "jellyfin:", "seerr:"];
  const normalizedCandidate = candidateTitle.trim().toLowerCase();

  if (noisyPrefixes.some((prefix) => normalizedCandidate.startsWith(prefix))) {
    return false;
  }

  return normalizeSearchText(currentTitle) !== normalizeSearchText(candidateTitle);
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
    ["poster", "cover", "primary"].includes(
      String(item.coverType || item.type || "").toLowerCase(),
    )
  ) || images[0];
  const imageUrl = image
    ? pickString(image, ["remoteUrl", "url", "imageUrl", "thumbnailUrl"])
    : undefined;

  return imageUrl && isLikelyImageUrl(imageUrl) ? imageUrl : null;
}

function findImageArray(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates = [
    data["images"],
    isObject(data["movie"]) ? data["movie"].images : undefined,
    isObject(data["series"]) ? data["series"].images : undefined,
  ];

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

function normalizeMediaType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "tv" || normalized === "series" || normalized === "season") return "series";
  if (normalized === "movie") return "movie";
  return value;
}
