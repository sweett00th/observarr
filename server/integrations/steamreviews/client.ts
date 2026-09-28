import { getSharedSecret, getSteamreviewsUrl } from "../../lib/config.ts";

/** Someone who signed in to steamreviews with Steam. */
export type SteamreviewsUser = {
  steamId: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  watching: number;
};

const steamIdPattern = /^7656[0-9]{13}$/;
const requestTimeoutMs = 10_000;
const maxAvatarBytes = 5 * 1024 * 1024;
const supportedAvatarTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
// Steam's avatar CDN. Avatars are fetched from nowhere else.
const steamAvatarHosts = new Set([
  "avatars.steamstatic.com",
  "avatars.akamai.steamstatic.com",
  "avatars.cloudflare.steamstatic.com",
  "avatars.fastly.steamstatic.com",
  "steamcdn-a.akamaihd.net",
]);

export class SteamreviewsConfigurationError extends Error {
  status = 400;
}

export class SteamreviewsRequestError extends Error {
  status = 502;
}

export function getSteamreviewsConfig(): { url: string; secret: string } {
  const url = getSteamreviewsUrl();
  const secret = getSharedSecret();

  if (!url || !secret) {
    throw new SteamreviewsConfigurationError(
      "Steam import requires STEAMREVIEWS_URL and SHARED_SECRET (the same value as OBSERVARR_SECRET in steamreviews)",
    );
  }

  return { url, secret };
}

/** steamreviews answers only on its LAN address, and only with the shared secret. */
export async function fetchSteamreviewsUsers(): Promise<SteamreviewsUser[]> {
  const { url, secret } = getSteamreviewsConfig();
  let response: Response;
  try {
    response = await fetch(`${url}/api/integrations/observarr/users`, {
      headers: { "Accept": "application/json", "x-observarr-secret": secret },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new SteamreviewsRequestError(
      `steamreviews could not be reached: ${error instanceof Error ? error.message : "no answer"}`,
    );
  }

  if (response.status === 404) {
    throw new SteamreviewsRequestError(
      "steamreviews refused the request. STEAMREVIEWS_URL must be its LAN address (not the public site), and SHARED_SECRET must match its OBSERVARR_SECRET.",
    );
  }

  if (!response.ok) {
    throw new SteamreviewsRequestError(
      `steamreviews users request failed with HTTP ${response.status}`,
    );
  }

  const payload: unknown = await response.json();
  const users = isObject(payload) && Array.isArray(payload.users) ? payload.users : null;
  if (!users) {
    throw new SteamreviewsRequestError("steamreviews users response had no users list");
  }

  return users.map(mapUser).filter((user): user is SteamreviewsUser => user !== null);
}

/** A Steam avatar from Steam's CDN, or null when there's none to fetch. */
export async function fetchSteamAvatar(avatarUrl: string): Promise<
  {
    bytes: Uint8Array;
    contentType: string;
  } | null
> {
  let url: URL;
  try {
    url = new URL(avatarUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !steamAvatarHosts.has(url.hostname)) {
    return null;
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new SteamreviewsRequestError(`Steam avatar request failed with HTTP ${response.status}`);
  }

  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (!contentType || !supportedAvatarTypes.has(contentType)) {
    throw new SteamreviewsRequestError("Steam avatar returned an unsupported image type");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxAvatarBytes) {
    throw new SteamreviewsRequestError("Steam avatar exceeds the 5 MB limit");
  }

  return { bytes, contentType };
}

function mapUser(value: unknown): SteamreviewsUser | null {
  if (!isObject(value) || typeof value.steamId !== "string") {
    return null;
  }

  const steamId = value.steamId.trim();
  if (!steamIdPattern.test(steamId)) {
    return null;
  }

  return {
    steamId,
    displayName: optionalString(value.displayName),
    avatarUrl: optionalString(value.avatarUrl),
    role: optionalString(value.role) ?? "member",
    watching: typeof value.watching === "number" ? value.watching : 0,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeContentType(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.split(";")[0].trim().toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
