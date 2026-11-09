/**
 * HTTP requests from background work to other LAN apps (Jellyfin, SABnzbd).
 *
 * Every attempt has a timeout that covers the response body too, failures that may pass on their
 * own (timeouts, refused connections, 5xx) are retried a few times, and error messages are built
 * from fixed phrases. Deno's fetch errors quote the whole request URL, so an upstream error's own
 * text is never passed on: a URL, query string or API key can't end up in a log or in the UI.
 */

export type RetryPolicy = {
  /** Per attempt, including reading the response body. */
  timeoutMs: number;
  /** Attempts in total; 1 means no retry. */
  attempts: number;
  /** Retry n waits n * retryDelayMs first. */
  retryDelayMs: number;
};

export type UpstreamDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type UpstreamFailureKind = "timeout" | "network" | "auth" | "http" | "response";

export class UpstreamRequestError extends Error {
  readonly kind: UpstreamFailureKind;
  readonly status: number | null;

  constructor(message: string, kind: UpstreamFailureKind, status: number | null = null) {
    super(message);
    this.name = "UpstreamRequestError";
    this.kind = kind;
    this.status = status;
  }
}

const maxResponseBytes = 8 * 1024 * 1024;

type Attempt =
  | { ok: true; text: string }
  | { ok: false; error: UpstreamRequestError; retryable: boolean };

/** The response body of a successful (2xx) request. Throws UpstreamRequestError otherwise. */
export async function requestText(
  service: string,
  url: string,
  init: RequestInit,
  policy: RetryPolicy,
  deps: UpstreamDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? delay;
  const attempts = Math.max(1, Math.floor(policy.attempts));
  let failure: UpstreamRequestError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      await sleep(policy.retryDelayMs * (attempt - 1));
    }

    const result = await attemptOnce(service, url, init, policy.timeoutMs, fetchImpl);
    if (result.ok) {
      return result.text;
    }

    failure = result.error;
    if (!result.retryable) {
      break;
    }
  }

  throw failure ?? new UpstreamRequestError(`${service} could not be reached`, "network");
}

async function attemptOnce(
  service: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return httpFailure(service, response.status);
    }

    const declaredBytes = Number(response.headers.get("content-length") ?? "0");
    if (declaredBytes > maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      return tooLarge(service);
    }

    const text = await response.text();
    if (text.length > maxResponseBytes) {
      return tooLarge(service);
    }

    return { ok: true, text };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        retryable: true,
        error: new UpstreamRequestError(
          `${service} did not answer within ${formatSeconds(timeoutMs)}`,
          "timeout",
        ),
      };
    }

    return {
      ok: false,
      retryable: true,
      error: new UpstreamRequestError(`${service} ${describeNetworkFailure(error)}`, "network"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function httpFailure(service: string, status: number): Attempt {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      retryable: false,
      error: new UpstreamRequestError(
        `${service} rejected the API key (HTTP ${status})`,
        "auth",
        status,
      ),
    };
  }

  if (status === 404) {
    return {
      ok: false,
      retryable: false,
      error: new UpstreamRequestError(
        `${service} answered HTTP 404; check its URL setting`,
        "http",
        status,
      ),
    };
  }

  return {
    ok: false,
    retryable: status >= 500 || status === 408 || status === 429,
    error: new UpstreamRequestError(`${service} answered HTTP ${status}`, "http", status),
  };
}

function tooLarge(service: string): Attempt {
  return {
    ok: false,
    retryable: false,
    error: new UpstreamRequestError(`${service} sent an unexpectedly large response`, "response"),
  };
}

/**
 * A fixed phrase for why a request never got an answer. Deno's error text names the URL, so only
 * its gist is used, never the text itself.
 */
export function describeNetworkFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";

  if (text.includes("invalid url") || text.includes("relative url")) {
    return "has an invalid URL setting";
  }

  if (text.includes("connection refused")) {
    return "refused the connection";
  }

  if (
    text.includes("dns") || text.includes("lookup") || text.includes("name or service not known") ||
    text.includes("no such host") || text.includes("nodename nor servname")
  ) {
    return "could not be found (DNS lookup failed)";
  }

  if (text.includes("certificate") || text.includes("tls") || text.includes("ssl")) {
    return "failed the TLS handshake";
  }

  if (text.includes("unreachable") || text.includes("no route")) {
    return "is unreachable";
  }

  if (
    text.includes("connection reset") || text.includes("broken pipe") ||
    text.includes("connection closed")
  ) {
    return "closed the connection";
  }

  return "could not be reached";
}

const secretPatterns = [
  /(apikey|api_key|api-key|token|secret|password)=([^&\s"']+)/gi,
  /(MediaBrowser\s+Token=")([^"]*)/gi,
];

/**
 * Text with the given secrets, and anything that looks like a credential in a query string or an
 * Authorization header, replaced by [redacted]. The last guard before text from elsewhere is
 * logged or shown.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let redacted = text;

  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }

  for (const pattern of secretPatterns) {
    redacted = redacted.replace(
      pattern,
      (_match, name: string) => `${name}${name.endsWith('"') ? "" : "="}[redacted]`,
    );
  }

  return redacted;
}

function formatSeconds(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
