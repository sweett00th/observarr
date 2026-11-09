import {
  requestText,
  type RetryPolicy,
  type UpstreamDeps,
  UpstreamRequestError,
} from "../../lib/upstream.ts";
import { jellyfinHeaders } from "./client.ts";

/** A Jellyfin session that has something playing (paused or not). */
export type JellyfinPlaybackSession = {
  /** Jellyfin's session id. */
  id: string;
  deviceId: string | null;
  userName: string | null;
  client: string | null;
  deviceName: string | null;
  itemId: string | null;
  /** "Series - Episode" for episodes, otherwise the item's name. */
  itemName: string | null;
  isPaused: boolean;
  /** "DirectPlay", "DirectStream" or "Transcode". */
  playMethod: string | null;
  /** When Jellyfin saw it pause (LastPausedDate, Jellyfin 10.9 and later), epoch ms. */
  pausedAt: number | null;
  /** Its last playback check-in or other activity, whichever is later, epoch ms. */
  lastSeenAt: number | null;
};

export type JellyfinSessionsSnapshot = {
  /** Every session Jellyfin reported, playing or not. */
  totalSessions: number;
  /** The sessions with a NowPlayingItem. Sessions that are only connected are left out. */
  playing: JellyfinPlaybackSession[];
};

export interface JellyfinSessionSource {
  fetchSessions(): Promise<JellyfinSessionsSnapshot>;
}

export const defaultJellyfinSessionsPolicy: RetryPolicy = {
  timeoutMs: 3000,
  attempts: 3,
  retryDelayMs: 300,
};

/**
 * Reads GET /Sessions. With an API key Jellyfin answers as an administrator, so the list covers
 * every user, remote ones included.
 */
export function createJellyfinSessionSource(
  options: { url: string; apiKey: string; policy?: Partial<RetryPolicy> } & UpstreamDeps,
): JellyfinSessionSource {
  const policy = { ...defaultJellyfinSessionsPolicy, ...options.policy };

  return {
    async fetchSessions() {
      const text = await requestText(
        "Jellyfin",
        `${options.url}/Sessions`,
        { headers: jellyfinHeaders(options.apiKey) },
        policy,
        options,
      );

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new UpstreamRequestError(
          "Jellyfin sent a sessions response that isn't JSON",
          "response",
        );
      }

      return parseJellyfinSessions(payload);
    },
  };
}

export function parseJellyfinSessions(payload: unknown): JellyfinSessionsSnapshot {
  if (!Array.isArray(payload)) {
    throw new UpstreamRequestError("Jellyfin's sessions response wasn't a list", "response");
  }

  const playing: JellyfinPlaybackSession[] = [];

  payload.forEach((value, index) => {
    if (!isObject(value) || !isObject(value.NowPlayingItem)) {
      return;
    }

    const item = value.NowPlayingItem;
    const playState = isObject(value.PlayState) ? value.PlayState : {};

    playing.push({
      id: optionalString(value.Id) ?? `session-${index}`,
      deviceId: optionalString(value.DeviceId),
      userName: optionalString(value.UserName),
      client: optionalString(value.Client),
      deviceName: optionalString(value.DeviceName),
      itemId: optionalString(item.Id),
      itemName: describeItem(item),
      isPaused: playState.IsPaused === true,
      playMethod: optionalString(playState.PlayMethod),
      pausedAt: parseJellyfinDate(value.LastPausedDate),
      lastSeenAt: latest(
        parseJellyfinDate(value.LastPlaybackCheckIn),
        parseJellyfinDate(value.LastActivityDate),
      ),
    });
  });

  return { totalSessions: payload.length, playing };
}

/**
 * Jellyfin dates are UTC with seven fractional digits, e.g. 2026-11-09T18:04:05.1234567Z.
 * One without a zone is read as UTC too (Date.parse would take it as local time). Jellyfin's
 * "never" (0001-01-01) and anything unparseable come back as null.
 */
export function parseJellyfinDate(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  let text = value.trim().replace(/(\.\d{3})\d+/, "$1");
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) {
    text = `${text}Z`;
  }

  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).getUTCFullYear() < 2000) {
    return null;
  }

  return parsed;
}

function describeItem(item: Record<string, unknown>): string | null {
  const name = optionalString(item.Name);
  const seriesName = optionalString(item.SeriesName);

  if (seriesName && name && seriesName !== name) {
    return `${seriesName} - ${name}`;
  }

  return name ?? seriesName;
}

function latest(...values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
