import type { Database } from "../db/index.ts";
import { firstRow } from "../db/index.ts";
import { getWebhookBaseUrl, notificationsEnabled } from "../lib/config.ts";
import {
  createTextbeltClient,
  type TextbeltClient,
  TextbeltConfigurationError,
} from "../providers/textbeltClient.ts";
import { getOrCreateEventTemplate } from "./eventTemplates.ts";
import {
  createPendingReceipt,
  markReceiptRejected,
  markReceiptSubmissionUnknown,
  markReceiptSubmitted,
  maskPhoneNumber,
} from "./receiptService.ts";
import { renderTemplate } from "./templateRenderer.ts";
import { ValidationError } from "./profiles.ts";

export type PhoneOptInState = "not_sent" | "pending" | "opted_in" | "opted_out" | "disabled";

export type ProfilePhoneNumber = {
  id: number;
  profileId: number;
  phoneNumber: string;
  label: string | null;
  enabled: boolean;
  optInState: PhoneOptInState;
  welcomeSentAt: string | null;
  optedInAt: string | null;
  optedOutAt: string | null;
  lastResponseText: string | null;
  lastResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PhoneNumberInput = {
  id?: unknown;
  phoneNumber?: unknown;
  label?: unknown;
  enabled?: unknown;
};

type SqlValue = string | number | null;

const optInPattern =
  /\b(y|yes|ok|okay|c|confirm|confirmed|consent|approve|approved|agree|agreed|start|subscribe|subscribed|opt\s*in)\b/i;
const optOutPattern = /\b(stop|stopall|unsubscribe|cancel|end|quit|opt\s*out|no)\b/i;

export function listProfilePhoneNumbers(db: Database, profileId: number): ProfilePhoneNumber[] {
  return [...db.query(
    `
    SELECT id, profile_id, phone_number, label, enabled, welcome_sent_at, opted_in_at,
      opted_out_at, last_response_text, last_response_at, created_at, updated_at
    FROM notification_profile_phone_numbers
    WHERE profile_id = ?
    ORDER BY id ASC
  `,
    [profileId],
  )].map(mapPhoneNumber);
}

export function getProfilePhoneNumber(
  db: Database,
  profileId: number,
  phoneNumberId: number,
): ProfilePhoneNumber | null {
  const row = firstRow(
    db,
    `
    SELECT id, profile_id, phone_number, label, enabled, welcome_sent_at, opted_in_at,
      opted_out_at, last_response_text, last_response_at, created_at, updated_at
    FROM notification_profile_phone_numbers
    WHERE profile_id = ? AND id = ?
  `,
    [profileId, phoneNumberId],
  );
  return row ? mapPhoneNumber(row) : null;
}

export function replaceProfilePhoneNumbers(
  db: Database,
  profileId: number,
  input: PhoneNumberInput[],
): void {
  if (!Array.isArray(input)) {
    throw new ValidationError("Phone numbers must be an array");
  }

  const normalized = input.map(normalizePhoneNumberInput);
  const seen = new Set<string>();
  for (const phone of normalized) {
    if (seen.has(phone.phoneNumber)) {
      throw new ValidationError("Duplicate phone number on notification profile");
    }
    seen.add(phone.phoneNumber);
  }

  const existing = new Map(
    listProfilePhoneNumbers(db, profileId).map((phone) => [phone.id, phone]),
  );
  const keepIds = new Set<number>();
  const now = new Date().toISOString();

  for (const phone of normalized) {
    if (phone.id && existing.has(phone.id)) {
      keepIds.add(phone.id);
      db.query(
        `
        UPDATE notification_profile_phone_numbers
        SET phone_number = ?, label = ?, enabled = ?, updated_at = ?
        WHERE id = ? AND profile_id = ?
      `,
        [phone.phoneNumber, phone.label, phone.enabled ? 1 : 0, now, phone.id, profileId],
      );
      continue;
    }

    db.query(
      `
      INSERT INTO notification_profile_phone_numbers (
        profile_id, phone_number, label, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      [profileId, phone.phoneNumber, phone.label, phone.enabled ? 1 : 0, now, now],
    );
    const id = Number(firstRow(db, "SELECT last_insert_rowid()")?.[0]);
    keepIds.add(id);
  }

  for (const id of existing.keys()) {
    if (!keepIds.has(id)) {
      db.query("DELETE FROM notification_profile_phone_numbers WHERE id = ? AND profile_id = ?", [
        id,
        profileId,
      ]);
    }
  }

  const primary = normalized[0]?.phoneNumber ?? null;
  db.query("UPDATE notification_profiles SET phone_number = ?, updated_at = ? WHERE id = ?", [
    primary,
    now,
    profileId,
  ]);
}

export async function sendWelcomeOptInMessage(
  db: Database,
  profileId: number,
  phoneNumberId: number,
  client: TextbeltClient = createTextbeltClient(),
): Promise<ProfilePhoneNumber> {
  const phone = getProfilePhoneNumber(db, profileId, phoneNumberId);
  if (!phone) {
    throw new ValidationError("Phone number not found");
  }
  if (!phone.enabled) {
    throw new ValidationError("Phone number is disabled");
  }
  if (!notificationsEnabled()) {
    throw new ValidationError("NOTIFICATIONS_ENABLED must be true before sending opt-in texts");
  }

  const profileName = nullableString(
    firstRow(db, "SELECT display_name FROM notification_profiles WHERE id = ?", [profileId])?.[0],
  ) ?? "there";
  const template = getOrCreateEventTemplate(db, "system", "sms_opt_in_welcome");
  const now = new Date().toISOString();
  const renderContext = {
    appName: "ObservaRR",
    source: "System",
    eventType: "sms_opt_in_welcome",
    eventTitle: "SMS opt-in welcome",
    eventMessage:
      "Consent message sent manually before a phone number can receive ObservaRR SMS notifications.",
    occurredAt: now,
    profileName,
    optInKeyword: "YES",
    optOutKeyword: "STOP",
  };
  const rendered = renderTemplate(
    "system",
    "sms_opt_in_welcome",
    template.smsBodyTemplate,
    renderContext,
  );

  if (!rendered.ok) {
    throw new ValidationError(rendered.errors.join(" ") || "Could not render SMS opt-in template");
  }

  const message = rendered.rendered.trim();
  if (!message) {
    throw new ValidationError("SMS opt-in welcome template cannot be blank");
  }

  const receipt = createPendingReceipt(db, {
    eventDedupeKey: `sms-opt-in:${phone.id}:${Date.now()}`,
    eventSource: "system",
    eventType: "sms_opt_in_welcome",
    eventTitle: "SMS opt-in welcome",
    profileId,
    profilePhoneNumberId: phone.id,
    templateId: template.id,
    templateRevision: template.revision,
    renderedBody: message,
    renderContext: { ...renderContext, profileId, phoneNumberId: phone.id, purpose: "sms_opt_in" },
    destinationMasked: maskPhoneNumber(phone.phoneNumber),
  });

  if (!receipt) {
    throw new ValidationError("Could not create SMS opt-in receipt");
  }

  try {
    const result = await client.sendSms(phone.phoneNumber, message, {
      replyWebhookUrl: getTextbeltReplyWebhookUrl(),
    });
    if (result.kind === "submitted") {
      markReceiptSubmitted(db, receipt.id, {
        providerMessageId: result.textId,
        quotaRemaining: result.quotaRemaining,
        response: result.response,
      });
      db.query(
        `
        UPDATE notification_profile_phone_numbers
        SET welcome_sent_at = COALESCE(welcome_sent_at, ?), updated_at = ?
        WHERE id = ? AND profile_id = ?
      `,
        [now, new Date().toISOString(), phone.id, profileId],
      );
    } else if (result.kind === "rejected") {
      markReceiptRejected(db, receipt.id, {
        error: result.error,
        quotaRemaining: result.quotaRemaining,
        response: result.response,
      });
      throw new ValidationError(result.error);
    } else {
      markReceiptSubmissionUnknown(db, receipt.id, {
        error: result.error,
        response: result.response,
      });
      throw new ValidationError(result.error);
    }
  } catch (error) {
    if (error instanceof TextbeltConfigurationError || error instanceof ValidationError) {
      throw error;
    }
    markReceiptSubmissionUnknown(db, receipt.id, {
      error: error instanceof Error ? error.message : "SMS opt-in submission failed ambiguously",
    });
    throw error;
  }

  return getProfilePhoneNumber(db, profileId, phone.id)!;
}

export async function sendPendingWelcomeOptInMessages(
  db: Database,
  profileId: number,
  client: TextbeltClient = createTextbeltClient(),
): Promise<{ sent: number; failed: number; phones: ProfilePhoneNumber[] }> {
  let sent = 0;
  let failed = 0;
  const updated: ProfilePhoneNumber[] = [];
  for (const phone of listProfilePhoneNumbers(db, profileId)) {
    if (phone.enabled && phone.optInState === "not_sent") {
      try {
        updated.push(await sendWelcomeOptInMessage(db, profileId, phone.id, client));
        sent += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { sent, failed, phones: updated };
}

export function recordTextbeltReply(db: Database, input: {
  fromNumber: unknown;
  text: unknown;
  raw: Record<string, unknown>;
}): {
  matched: boolean;
  status: "opted_in" | "opted_out" | "unknown";
  phone: ProfilePhoneNumber | null;
} {
  const phoneNumber = normalizePhoneNumber(input.fromNumber);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) {
    throw new ValidationError("Textbelt reply text is required");
  }

  const phone = findPhoneByPossibleFormats(db, phoneNumber);
  const status = interpretReply(text);
  const now = new Date().toISOString();

  if (phone) {
    db.query(
      `
      UPDATE notification_profile_phone_numbers
      SET last_response_text = ?, last_response_at = ?,
        opted_in_at = CASE WHEN ? = 'opted_in' THEN ? ELSE opted_in_at END,
        opted_out_at = CASE WHEN ? = 'opted_out' THEN ? WHEN ? = 'opted_in' THEN NULL ELSE opted_out_at END,
        updated_at = ?
      WHERE id = ?
    `,
      [text, now, status, now, status, now, status, now, phone.id],
    );
  }

  db.query(
    `
    INSERT INTO textbelt_inbound_replies (
      profile_phone_number_id, profile_id, from_number_masked, response_text,
      interpreted_status, raw_json, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      phone?.id ?? null,
      phone?.profileId ?? null,
      maskPhoneNumber(phoneNumber),
      text,
      status,
      JSON.stringify(sanitizeReply(input.raw)),
      now,
      now,
    ],
  );

  const updated = phone ? getProfilePhoneNumber(db, phone.profileId, phone.id) : null;
  return { matched: Boolean(phone), status, phone: updated };
}

export function normalizePhoneNumber(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("Phone number must be a string");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError("Phone number is required");
  }

  if (!trimmed.startsWith("+")) {
    const usNumber = trimmed.replace(/[\s().-]/g, "");
    if (!/^\d{10}$/.test(usNumber)) {
      throw new ValidationError(
        "Phone number must be a 10-digit U.S. number or an international number starting with +",
      );
    }
    return usNumber;
  }

  const normalized = `+${trimmed.slice(1).replace(/[\s().-]/g, "")}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new ValidationError("International phone number must be a valid E.164-style number");
  }
  return normalized;
}

function normalizePhoneNumberInput(input: PhoneNumberInput): {
  id: number | null;
  phoneNumber: string;
  label: string | null;
  enabled: boolean;
} {
  const id = input.id === undefined || input.id === null || input.id === ""
    ? null
    : Number(input.id);
  if (id !== null && (!Number.isInteger(id) || id < 1)) {
    throw new ValidationError("Invalid phone number id");
  }
  return {
    id,
    phoneNumber: normalizePhoneNumber(input.phoneNumber),
    label: nullableTrimmedString(input.label),
    enabled: input.enabled === undefined ? true : input.enabled === true,
  };
}

function findPhoneByPossibleFormats(db: Database, phoneNumber: string): ProfilePhoneNumber | null {
  const candidates = new Set<string>([phoneNumber]);
  const digits = phoneNumber.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    candidates.add(digits.slice(1));
  }
  if (digits.length === 10) {
    candidates.add(`+1${digits}`);
  }

  for (const candidate of candidates) {
    const row = firstRow(
      db,
      `
      SELECT id, profile_id, phone_number, label, enabled, welcome_sent_at, opted_in_at,
        opted_out_at, last_response_text, last_response_at, created_at, updated_at
      FROM notification_profile_phone_numbers
      WHERE phone_number = ?
    `,
      [candidate],
    );
    if (row) return mapPhoneNumber(row);
  }
  return null;
}

function interpretReply(text: string): "opted_in" | "opted_out" | "unknown" {
  if (optOutPattern.test(text)) return "opted_out";
  if (optInPattern.test(text)) return "opted_in";
  return "unknown";
}

function getTextbeltReplyWebhookUrl(): string | undefined {
  const baseUrl = getWebhookBaseUrl();
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}/webhook/textbelt/reply` : undefined;
}

function mapPhoneNumber(row: unknown[]): ProfilePhoneNumber {
  const enabled = Number(row[4]) === 1;
  const optedInAt = nullableString(row[6]);
  const optedOutAt = nullableString(row[7]);
  const welcomeSentAt = nullableString(row[5]);
  return {
    id: Number(row[0]),
    profileId: Number(row[1]),
    phoneNumber: String(row[2]),
    label: nullableString(row[3]),
    enabled,
    optInState: !enabled
      ? "disabled"
      : optedOutAt
      ? "opted_out"
      : optedInAt
      ? "opted_in"
      : welcomeSentAt
      ? "pending"
      : "not_sent",
    welcomeSentAt,
    optedInAt,
    optedOutAt,
    lastResponseText: nullableString(row[8]),
    lastResponseAt: nullableString(row[9]),
    createdAt: String(row[10]),
    updatedAt: String(row[11]),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableTrimmedString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ValidationError("Expected a string value");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeReply(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["fromNumber", "text", "messageId", "textId", "receivedAt"]) {
    if (key in raw) result[key] = /number/i.test(key) ? "[redacted]" : raw[key];
  }
  return result;
}
