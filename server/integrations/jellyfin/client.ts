import { getJellyfinApiKey, getJellyfinUrl } from "../../lib/config.ts";

export type JellyfinUser = {
  id: string;
  username: string;
  email: string | null;
  hasPrimaryAvatar: boolean;
};

const maxAvatarBytes = 5 * 1024 * 1024;
const supportedAvatarTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export class JellyfinConfigurationError extends Error {
  status = 400;
}

export class JellyfinRequestError extends Error {
  status = 502;
}

export function getJellyfinConfig(): { url: string; apiKey: string } {
  const url = getJellyfinUrl();
  const apiKey = getJellyfinApiKey();

  if (!url || !apiKey) {
    throw new JellyfinConfigurationError(
      "Jellyfin import requires JELLYFIN_URL and JELLYFIN_API_KEY",
    );
  }

  return { url, apiKey };
}

export async function fetchJellyfinUsers(): Promise<JellyfinUser[]> {
  const { url, apiKey } = getJellyfinConfig();
  const response = await fetch(`${url}/Users`, {
    headers: jellyfinHeaders(apiKey),
  });

  if (!response.ok) {
    throw new JellyfinRequestError(`Jellyfin users request failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new JellyfinRequestError("Jellyfin users response was not an array");
  }

  return payload.map(mapJellyfinUser).filter((user): user is JellyfinUser => user !== null);
}

export async function fetchJellyfinPrimaryAvatar(userId: string): Promise<
  {
    bytes: Uint8Array;
    contentType: string;
  } | null
> {
  const { url, apiKey } = getJellyfinConfig();
  const response = await fetch(`${url}/Users/${encodeURIComponent(userId)}/Images/Primary`, {
    headers: jellyfinHeaders(apiKey),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new JellyfinRequestError(`Jellyfin avatar request failed with HTTP ${response.status}`);
  }

  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (!contentType || !supportedAvatarTypes.has(contentType)) {
    throw new JellyfinRequestError("Jellyfin avatar returned an unsupported image type");
  }

  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > maxAvatarBytes) {
    throw new JellyfinRequestError("Jellyfin avatar exceeds the 5 MB limit");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxAvatarBytes) {
    throw new JellyfinRequestError("Jellyfin avatar exceeds the 5 MB limit");
  }

  return { bytes, contentType };
}

function jellyfinHeaders(apiKey: string): HeadersInit {
  return {
    "Accept": "application/json",
    "X-Emby-Token": apiKey,
  };
}

function mapJellyfinUser(value: unknown): JellyfinUser | null {
  if (!isObject(value)) {
    return null;
  }

  const id = firstString(value, ["Id", "id"]);
  const username = firstString(value, ["Name", "name", "Username", "username"]);

  if (!id || !username) {
    return null;
  }

  return {
    id,
    username,
    email: firstString(value, ["Email", "email"]),
    hasPrimaryAvatar: Boolean(firstString(value, ["PrimaryImageTag", "primaryImageTag"])),
  };
}

function firstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
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
