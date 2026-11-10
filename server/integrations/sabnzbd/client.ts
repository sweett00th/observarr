import {
  redactSecrets,
  requestText,
  type RetryPolicy,
  type UpstreamDeps,
  UpstreamRequestError,
} from "../../lib/upstream.ts";

/** What bandwidth automation reads from SABnzbd's queue. */
export type SabnzbdQueueStatus = {
  /** The download speed limit in bytes/s; 0 when there is none. */
  speedLimitBytesPerSecond: number;
  /** The same limit as a percentage of SABnzbd's configured line speed, as SABnzbd reports it. */
  speedLimitPercent: number | null;
  /** The measured download speed in bytes/s. */
  downloadBytesPerSecond: number | null;
  /** "Downloading", "Paused" or "Idle". */
  queueStatus: string | null;
  /** The whole queue is paused (by hand, the scheduler, or for post-processing). */
  paused: boolean | null;
  version: string | null;
};

/**
 * The two SABnzbd API calls bandwidth automation makes. It never pauses or resumes the queue and
 * never touches jobs, categories or post-processing.
 */
export interface SabnzbdApi {
  getQueueStatus(): Promise<SabnzbdQueueStatus>;
  /** Sets the download speed limit in bytes/s; 0 removes it. */
  setSpeedLimit(bytesPerSecond: number): Promise<void>;
}

export const defaultSabnzbdPolicy: RetryPolicy = {
  timeoutMs: 3000,
  attempts: 3,
  retryDelayMs: 300,
};

export function createSabnzbdClient(
  options: { url: string; apiKey: string; policy?: Partial<RetryPolicy> } & UpstreamDeps,
): SabnzbdApi {
  const policy = { ...defaultSabnzbdPolicy, ...options.policy };
  const endpoint = `${options.url}/api`;

  async function call(params: Record<string, string>): Promise<Record<string, unknown>> {
    // The key travels in the POST body (SABnzbd reads form fields like query parameters), so it
    // is never part of a URL that could be logged or quoted in an error.
    const body = new URLSearchParams({ ...params, output: "json", apikey: options.apiKey });
    const text = await requestText(
      "SABnzbd",
      endpoint,
      {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
      policy,
      options,
    );

    return parseSabnzbdResponse(text, options.apiKey);
  }

  return {
    async getQueueStatus() {
      // limit=1: only the header fields are needed, not every job in the queue.
      const payload = await call({ mode: "queue", start: "0", limit: "1" });
      return parseSabnzbdQueue(payload.queue);
    },

    async setSpeedLimit(bytesPerSecond: number) {
      const payload = await call({
        mode: "config",
        name: "speedlimit",
        value: sabnzbdSpeedLimitValue(bytesPerSecond),
      });

      if (payload.status !== true) {
        throw new UpstreamRequestError(
          "SABnzbd did not confirm the speed limit change",
          "response",
        );
      }
    },
  };
}

/**
 * The `value` for mode=config&name=speedlimit. SABnzbd reads a bare number from 1 to 100 as a
 * percentage of its line speed, and its K/M suffixes are binary (K = 1024 bytes). So a limit is
 * sent in K, divided exactly (10,000,000 B/s is "9765.625K"), which SABnzbd multiplies back to the
 * same byte count. "0" removes the limit whether or not a line speed is configured; SABnzbd's own
 * "100" does nothing without one.
 */
export function sabnzbdSpeedLimitValue(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    throw new RangeError("A speed limit must be 0 or a positive number of bytes per second");
  }

  const bytes = Math.round(bytesPerSecond);
  if (bytes === 0) {
    return "0";
  }

  if (bytes < 1024) {
    throw new RangeError("Speed limits under 1 KiB/s are not supported");
  }

  return `${bytes / 1024}K`;
}

export function parseSabnzbdResponse(text: string, apiKey?: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // Older versions answer a bad key with plain text and HTTP 200.
    if (/api key/i.test(text)) {
      throw new UpstreamRequestError("SABnzbd rejected the API key", "auth");
    }
    throw new UpstreamRequestError("SABnzbd sent a response that isn't JSON", "response");
  }

  if (!isObject(payload)) {
    throw new UpstreamRequestError("SABnzbd sent an unexpected response", "response");
  }

  if (payload.status === false) {
    const reason = typeof payload.error === "string" && payload.error.trim().length > 0
      ? redactSecrets(payload.error.trim(), [apiKey]).slice(0, 200)
      : "no reason given";
    throw new UpstreamRequestError(
      `SABnzbd refused the request: ${reason}`,
      /api key/i.test(reason) ? "auth" : "response",
    );
  }

  return payload;
}

export function parseSabnzbdQueue(queue: unknown): SabnzbdQueueStatus {
  if (!isObject(queue)) {
    throw new UpstreamRequestError("SABnzbd's queue response had no queue", "response");
  }

  if (!("speedlimit_abs" in queue)) {
    throw new UpstreamRequestError("SABnzbd's queue didn't report its speed limit", "response");
  }

  // "" (older versions) and "0" both mean no limit. Newer versions send whole numbers, older
  // ones floats such as "4718592.0".
  const limit = parseNumber(queue.speedlimit_abs);
  const kibPerSecond = parseNumber(queue.kbpersec);

  return {
    speedLimitBytesPerSecond: limit !== null && limit > 0 ? Math.round(limit) : 0,
    speedLimitPercent: parseNumber(queue.speedlimit),
    downloadBytesPerSecond: kibPerSecond === null ? null : Math.round(kibPerSecond * 1024),
    queueStatus: typeof queue.status === "string" ? queue.status : null,
    paused: typeof queue.paused === "boolean" ? queue.paused : null,
    version: typeof queue.version === "string" ? queue.version : null,
  };
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
