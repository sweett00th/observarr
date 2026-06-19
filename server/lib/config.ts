export const APP_NAME = "sms-gateway";
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
