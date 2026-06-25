import { getTextbeltKey, getTextbeltSender } from "../lib/config.ts";

export type TextbeltSendResult =
  | {
    kind: "submitted";
    textId: string | null;
    quotaRemaining: number | null;
    response: Record<string, unknown>;
  }
  | {
    kind: "rejected";
    error: string;
    quotaRemaining: number | null;
    response: Record<string, unknown>;
  }
  | {
    kind: "submission_unknown";
    error: string;
    response?: Record<string, unknown>;
  };

export type TextbeltStatusResult =
  | {
    kind: "ok";
    status: "delivered" | "sent" | "sending" | "failed" | "unknown";
    response: Record<string, unknown>;
  }
  | { kind: "failed"; error: string; response?: Record<string, unknown> };

export interface TextbeltClient {
  sendSms(phoneNumber: string, message: string): Promise<TextbeltSendResult>;
  getStatus(textId: string): Promise<TextbeltStatusResult>;
}

const textbeltSendUrl = "https://textbelt.com/text";
const textbeltStatusUrl = "https://textbelt.com/status";

export class TextbeltConfigurationError extends Error {}

export function createTextbeltClient(): TextbeltClient {
  return new RealTextbeltClient();
}

class RealTextbeltClient implements TextbeltClient {
  async sendSms(phoneNumber: string, message: string): Promise<TextbeltSendResult> {
    const key = getTextbeltKey();
    if (!key) {
      throw new TextbeltConfigurationError("TEXTBELT_KEY is required for SMS dispatch");
    }

    const body = new URLSearchParams();
    body.set("phone", phoneNumber);
    body.set("message", message);
    body.set("key", key);

    const sender = getTextbeltSender();
    if (sender) {
      body.set("sender", sender);
    }

    try {
      const response = await fetch(textbeltSendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const payload = await readJsonObject(response);
      const sanitized = sanitizeTextbeltResponse(payload);
      const quotaRemaining = numberField(payload, "quotaRemaining");

      if (payload.success === true) {
        return {
          kind: "submitted",
          textId: stringField(payload, "textId"),
          quotaRemaining,
          response: sanitized,
        };
      }

      return {
        kind: "rejected",
        error: stringField(payload, "error") ??
          `Textbelt rejected request with HTTP ${response.status}`,
        quotaRemaining,
        response: sanitized,
      };
    } catch (error) {
      return {
        kind: "submission_unknown",
        error: error instanceof Error ? error.message : "Textbelt submission failed ambiguously",
      };
    }
  }

  async getStatus(textId: string): Promise<TextbeltStatusResult> {
    try {
      const response = await fetch(`${textbeltStatusUrl}/${encodeURIComponent(textId)}`);
      const payload = await readJsonObject(response);
      const sanitized = sanitizeTextbeltResponse(payload);
      const rawStatus =
        (stringField(payload, "status") ?? stringField(payload, "deliveryStatus") ?? "unknown")
          .toLowerCase();

      if (!response.ok) {
        return {
          kind: "failed",
          error: `Textbelt status request failed with HTTP ${response.status}`,
          response: sanitized,
        };
      }

      return {
        kind: "ok",
        status: mapStatus(rawStatus),
        response: sanitized,
      };
    } catch (error) {
      return {
        kind: "failed",
        error: error instanceof Error ? error.message : "Textbelt status check failed",
      };
    }
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return isObject(value) ? value : { value };
  } catch {
    return { ok: false, status: response.status, error: "Invalid JSON response" };
  }
}

function mapStatus(status: string): "delivered" | "sent" | "sending" | "failed" | "unknown" {
  if (status === "delivered") return "delivered";
  if (status === "sent") return "sent";
  if (status === "sending" || status === "queued") return "sending";
  if (status === "failed" || status === "undelivered") return "failed";
  return "unknown";
}

function sanitizeTextbeltResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "success",
    "textId",
    "quotaRemaining",
    "error",
    "status",
    "deliveryStatus",
    "timestamp",
  ];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in payload) {
      result[key] = payload[key];
    }
  }
  return result;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
