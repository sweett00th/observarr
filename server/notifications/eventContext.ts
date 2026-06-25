import type { LiveEvent } from "../events/eventBus.ts";
import { mapToCatalogEventType } from "./templateCatalog.ts";
import type { NotificationProfile } from "./profiles.ts";

export type CanonicalEventContext = {
  source: string;
  eventType: string;
  eventTitle: string;
  eventMessage: string;
  occurredAt: string;
  eventDedupeKey: string;
  templateContext: Record<string, string>;
};

export function buildCanonicalEventContext(
  event: LiveEvent,
  profile?: Pick<NotificationProfile, "displayName">,
): CanonicalEventContext | null {
  if (event.source === "test") {
    return null;
  }

  const eventType = mapToCatalogEventType(event.source, event.eventType);
  if (!eventType) {
    return null;
  }

  const raw = isObject(event.rawPayload) ? event.rawPayload : {};
  const sourceLabel = sourceDisplayName(event.source);
  const mediaTitle = event.entityTitle ||
    pickNestedString(raw, [["movie", "title"], ["series", "title"], ["episode", "title"]]) ||
    pickString(raw, ["mediaTitle", "title", "subject", "name", "Name"]);
  const context = compactStringRecord({
    appName: "ObservaRR",
    source: sourceLabel,
    eventType,
    eventTitle: event.title,
    eventMessage: event.message,
    occurredAt: event.timestamp,
    profileName: profile?.displayName,
    mediaTitle,
    mediaYear: pickString(raw, ["mediaYear", "year", "releaseYear"]) ||
      pickNestedString(raw, [["movie", "year"], ["series", "year"]]),
    quality: pickString(raw, ["quality", "qualityProfile", "qualityVersion"]) ||
      pickNestedString(raw, [["quality", "quality"], ["movieFile", "quality"], [
        "episodeFile",
        "quality",
      ]]),
    fileSize: pickString(raw, ["fileSize", "size", "sizeLabel"]),
    libraryName: pickString(raw, ["libraryName", "library", "LibraryName"]),
    errorMessage: pickString(raw, ["error", "errorMessage", "message", "description"]),
    movieTitle: pickNestedString(raw, [["movie", "title"]]) ||
      (event.entityType?.toLowerCase() === "movie" ? mediaTitle : undefined),
    movieYear: pickNestedString(raw, [["movie", "year"]]) || pickString(raw, ["movieYear"]),
    seriesTitle: pickNestedString(raw, [["series", "title"]]) || pickString(raw, ["seriesTitle"]),
    episodeTitle: pickNestedString(raw, [["episode", "title"]]) ||
      pickString(raw, ["episodeTitle"]),
    seasonNumber: pickString(raw, ["seasonNumber", "season"]),
    episodeNumber: pickString(raw, ["episodeNumber", "episode"]),
    requestStatus: pickString(raw, ["requestStatus", "status"]),
    requesterName: pickString(raw, ["requesterName", "requestedBy", "userDisplayName"]),
    requestedByUsername: pickString(raw, ["requestedByUsername", "username", "userName"]),
    downloadName: pickString(raw, ["downloadName", "name", "Name", "jobName"]),
    category: pickString(raw, ["category"]),
    postProcessingStatus: pickString(raw, ["postProcessingStatus", "ppStatus"]),
    downloadStatus: pickString(raw, ["downloadStatus", "status"]),
    username: pickString(raw, ["username", "Username", "userName", "Name"]),
    deviceName: pickString(raw, ["deviceName", "DeviceName", "clientName"]),
    itemType: pickString(raw, ["itemType", "ItemType", "mediaType", "MediaType"]),
  });

  return {
    source: event.source,
    eventType,
    eventTitle: event.title,
    eventMessage: event.message,
    occurredAt: event.timestamp,
    eventDedupeKey: buildEventDedupeKey(event, eventType, raw, mediaTitle),
    templateContext: context,
  };
}

export function withProfileContext(
  context: CanonicalEventContext,
  profile: Pick<NotificationProfile, "displayName">,
): CanonicalEventContext {
  return {
    ...context,
    templateContext: {
      ...context.templateContext,
      profileName: profile.displayName,
    },
  };
}

function buildEventDedupeKey(
  event: LiveEvent,
  eventType: string,
  raw: Record<string, unknown>,
  mediaTitle?: string,
): string {
  const upstreamId = pickString(raw, [
    "id",
    "eventId",
    "requestId",
    "downloadId",
    "jobId",
    "movieId",
    "seriesId",
    "episodeId",
    "notificationId",
  ]) || pickNestedString(raw, [["movie", "id"], ["series", "id"], ["episode", "id"]]);

  if (upstreamId) {
    return `${event.source}:${eventType}:upstream:${sanitizeKey(upstreamId)}`;
  }

  const bucket = Math.floor(Date.parse(event.timestamp) / (5 * 60 * 1000));
  const fingerprint = [
    event.source,
    eventType,
    mediaTitle,
    event.entityType,
    event.title,
    event.message,
  ]
    .filter(Boolean)
    .join(":");
  return `${event.source}:${eventType}:fingerprint:${bucket}:${hashString(fingerprint)}`;
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
}

function sanitizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 80) || "unknown";
}

function compactStringRecord(values: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) {
      continue;
    }
    const stringValue = String(value).trim();
    if (
      stringValue.length > 0 &&
      !/(password|token|secret|api[_-]?key|authorization|phone|email)/i.test(key)
    ) {
      result[key] = stringValue;
    }
  }
  return result;
}

function sourceDisplayName(source: string): string {
  if (source === "sabnzbd") return "SABnzbd";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function pickString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
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
    if (typeof current === "string" && current.trim().length > 0) {
      return current.trim();
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      return String(current);
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
