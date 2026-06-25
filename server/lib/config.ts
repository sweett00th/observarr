export const APP_NAME = "observarr";
export const APP_VERSION = "0.1.0";

export function getEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value && value.trim().length > 0 ? value : undefined;
}

export function getPort(): number {
  const rawPort = getEnv("PORT");
  const port = rawPort ? Number(rawPort) : 3020;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }

  return port;
}

export function getDbPath(): string {
  return getEnv("DB_PATH") || "/data/observarr.db";
}

export function getAdminUsername(): string {
  return getEnv("ADMIN_USERNAME") || "admin";
}

export function getAdminPassword(): string | undefined {
  return getEnv("ADMIN_PASSWORD");
}

export function getSessionTtlDays(): number {
  const rawValue = getEnv("SESSION_TTL_DAYS");
  const ttlDays = rawValue ? Number(rawValue) : 7;

  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
    throw new Error(`Invalid SESSION_TTL_DAYS value: ${rawValue}`);
  }

  return ttlDays;
}

export function getCookieSecure(): boolean {
  return getEnv("COOKIE_SECURE") === "true";
}

export function getEventBufferMinutes(): number {
  const rawValue = getEnv("EVENT_BUFFER_MINUTES");
  const minutes = rawValue ? Number(rawValue) : 10;

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error(`Invalid EVENT_BUFFER_MINUTES value: ${rawValue}`);
  }

  return minutes;
}

export function getEventBufferMax(): number {
  const rawValue = getEnv("EVENT_BUFFER_MAX");
  const max = rawValue ? Number(rawValue) : 250;

  if (!Number.isInteger(max) || max < 1 || max > 5000) {
    throw new Error(`Invalid EVENT_BUFFER_MAX value: ${rawValue}`);
  }

  return max;
}

export function getEventRawMaxBytes(): number {
  const rawValue = getEnv("EVENT_RAW_MAX_BYTES");
  const maxBytes = rawValue ? Number(rawValue) : 20000;

  if (!Number.isInteger(maxBytes) || maxBytes < 1000 || maxBytes > 250000) {
    throw new Error(`Invalid EVENT_RAW_MAX_BYTES value: ${rawValue}`);
  }

  return maxBytes;
}

export function getEnvironment(): string {
  return getEnv("DENO_ENV") || getEnv("NODE_ENV") || "production";
}

export function getBuildInfo() {
  return {
    sha: getEnv("GITHUB_SHA") || getEnv("BUILD_SHA") || null,
    date: getEnv("BUILD_DATE") || null,
  };
}

export function isProviderConfigured(): boolean {
  return Boolean(
    getEnv("TWILIO_ACCOUNT_SID") &&
      getEnv("TWILIO_AUTH_TOKEN") &&
      getEnv("TWILIO_FROM") &&
      getEnv("SMS_TO"),
  );
}

export function getSharedSecret(): string | undefined {
  return getEnv("SHARED_SECRET");
}
