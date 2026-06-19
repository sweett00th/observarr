import {
  getEventBufferMax,
  getEventBufferMinutes,
  getEventRawMaxBytes,
} from "../lib/config.ts";

export type EventSourceName =
  | "jellyfin"
  | "seerr"
  | "radarr"
  | "sonarr"
  | "sabnzbd"
  | "system"
  | "test";

export type EventSeverity = "info" | "success" | "warning" | "error";

export type LiveEvent = {
  id: string;
  timestamp: string;
  source: EventSourceName;
  eventType: string;
  severity: EventSeverity;
  title: string;
  message: string;
  entityType?: string;
  entityTitle?: string;
  rawSummary?: Record<string, unknown>;
  rawPayload?: unknown;
};

type EventClient = {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
};

const textEncoder = new TextEncoder();
const secretKeyPattern = /(password|token|secret|apikey|api_key|authorization)/i;

class EventBus {
  #events: LiveEvent[] = [];
  #clients = new Map<string, EventClient>();

  recent(): LiveEvent[] {
    this.#prune();
    return [...this.#events];
  }

  findById(id: string): LiveEvent | null {
    this.#prune();
    return this.#events.find((event) => event.id === id) ?? null;
  }

  publish(event: Omit<LiveEvent, "id" | "timestamp">): LiveEvent {
    const liveEvent: LiveEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    this.#events.push(liveEvent);
    this.#prune();
    this.#broadcast(liveEvent);

    return liveEvent;
  }

  stream(signal: AbortSignal): ReadableStream<Uint8Array> {
    const clientId = crypto.randomUUID();

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const client = { id: clientId, controller };
        this.#clients.set(clientId, client);
        this.#send(client, ": connected\n\n");

        const keepalive = setInterval(() => {
          if (!this.#clients.has(clientId)) {
            clearInterval(keepalive);
            return;
          }

          this.#send(client, ": keepalive\n\n");
        }, 25000);

        signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          this.#clients.delete(clientId);
          try {
            controller.close();
          } catch {
            // The stream may already be closed by the runtime.
          }
        });
      },
      cancel: () => {
        this.#clients.delete(clientId);
      },
    });
  }

  #broadcast(event: LiveEvent): void {
    const payload = `event: message\ndata: ${JSON.stringify(event)}\n\n`;

    for (const client of this.#clients.values()) {
      this.#send(client, payload);
    }
  }

  #send(client: EventClient, payload: string): void {
    try {
      client.controller.enqueue(textEncoder.encode(payload));
    } catch {
      this.#clients.delete(client.id);
    }
  }

  #prune(): void {
    const cutoff = Date.now() - getEventBufferMinutes() * 60 * 1000;
    const max = getEventBufferMax();

    this.#events = this.#events.filter((event) => Date.parse(event.timestamp) >= cutoff);

    if (this.#events.length > max) {
      this.#events = this.#events.slice(this.#events.length - max);
    }
  }
}

export const eventBus = new EventBus();

export function normalizeWebhookEvent(
  source: EventSourceName,
  payload: unknown,
): Omit<LiveEvent, "id" | "timestamp"> {
  const data = isObject(payload) ? payload : {};
  const eventType = pickString(data, [
    "eventType",
    "event",
    "notificationType",
    "NotificationType",
    "notification_type",
    "type",
  ]) || "webhook";
  const title = pickString(data, ["title", "subject", "name", "Name"]) ||
    pickNestedString(data, [["movie", "title"], ["series", "title"], ["episode", "title"]]) ||
    `${sourceLabel(source)} event`;
  const message = pickString(data, ["message", "description", "body", "text"]) ||
    buildFallbackMessage(source, eventType, title);
  const entityTitle = pickNestedString(data, [["movie", "title"], ["series", "title"]]) ||
    pickString(data, ["entityTitle", "title", "name", "Name"]);
  const entityType = pickString(data, ["entityType", "mediaType", "MediaType"]);

  return {
    source,
    eventType,
    severity: inferSeverity(eventType, message),
    title,
    message,
    ...(entityType ? { entityType } : {}),
    ...(entityTitle ? { entityTitle } : {}),
    rawSummary: summarizeForEvent(payload),
    rawPayload: sanitizeRawPayload(payload),
  };
}

export function sanitizeRawPayload(payload: unknown): unknown {
  const sanitized = sanitizeValue("payload", payload);
  const serialized = JSON.stringify(sanitized);
  const maxBytes = getEventRawMaxBytes();
  const bytes = new TextEncoder().encode(serialized);

  if (bytes.length <= maxBytes) {
    return sanitized;
  }

  return {
    __truncated: true,
    __originalBytes: bytes.length,
    __maxBytes: maxBytes,
    preview: truncateUtf8(serialized, maxBytes),
  };
}

export function summarizeForEvent(payload: unknown): Record<string, unknown> {
  if (!isObject(payload)) {
    return {
      type: Array.isArray(payload) ? "array" : typeof payload,
    };
  }

  const summary: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload).slice(0, 25)) {
    summary[key] = sanitizeSummaryValue(key, value, 0);
  }

  return summary;
}

function sanitizeSummaryValue(key: string, value: unknown, depth: number): unknown {
  if (secretKeyPattern.test(key)) {
    return "[redacted]";
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 200)}...` : value;
  }

  if (Array.isArray(value)) {
    if (depth >= 1) {
      return `[array:${value.length}]`;
    }

    return value.slice(0, 5).map((item) => sanitizeSummaryValue(key, item, depth + 1));
  }

  if (isObject(value)) {
    if (depth >= 1) {
      return "{object}";
    }

    const nested: Record<string, unknown> = {};

    for (const [nestedKey, nestedValue] of Object.entries(value).slice(0, 10)) {
      nested[nestedKey] = sanitizeSummaryValue(nestedKey, nestedValue, depth + 1);
    }

    return nested;
  }

  return String(value);
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (secretKeyPattern.test(key)) {
    return "[redacted]";
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item));
  }

  if (isObject(value)) {
    const sanitized: Record<string, unknown> = {};

    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      sanitized[nestedKey] = sanitizeValue(nestedKey, nestedValue);
    }

    return sanitized;
  }

  return String(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  const truncated = bytes.slice(0, maxBytes);
  return `${new TextDecoder().decode(truncated)}...`;
}

function inferSeverity(eventType: string, message: string): EventSeverity {
  const value = `${eventType} ${message}`.toLowerCase();

  if (/(error|failed|failure|fatal)/.test(value)) {
    return "error";
  }

  if (/(warning|warn|missing)/.test(value)) {
    return "warning";
  }

  if (/(success|complete|completed|sent|available|grabbed|downloaded)/.test(value)) {
    return "success";
  }

  return "info";
}

function buildFallbackMessage(source: EventSourceName, eventType: string, title: string): string {
  return `${sourceLabel(source)} sent ${eventType}: ${title}`;
}

function sourceLabel(source: EventSourceName): string {
  if (source === "seerr") {
    return "Jellyseerr/Seerr";
  }

  if (source === "sabnzbd") {
    return "SABnzbd";
  }

  return source.charAt(0).toUpperCase() + source.slice(1);
}

function pickString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
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
  }

  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
