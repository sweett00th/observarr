import type { Database } from "../db/index.ts";
import { firstRow } from "../db/index.ts";

type SqlValue = string | number | null;

export type SubmissionStatus =
  | "pending"
  | "submitted"
  | "rejected"
  | "failed"
  | "submission_unknown"
  | "render_failed"
  | "skipped";
export type DeliveryStatus =
  | "not_applicable"
  | "unknown"
  | "sending"
  | "sent"
  | "delivered"
  | "failed";

export type MessageReceipt = {
  id: number;
  eventDedupeKey: string | null;
  eventSource: string | null;
  eventType: string | null;
  eventTitle: string | null;
  profileId: number | null;
  profileName: string | null;
  profilePhoneNumberId: number | null;
  channel: string;
  provider: string | null;
  templateId: number | null;
  templateRevision: number | null;
  renderedBody: string | null;
  renderContext: unknown;
  destinationMasked: string | null;
  providerMessageId: string | null;
  submissionStatus: SubmissionStatus;
  deliveryStatus: DeliveryStatus;
  providerError: string | null;
  providerResponse: unknown;
  quotaRemaining: number | null;
  attemptedAt: string;
  submittedAt: string | null;
  lastStatusCheckAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function maskPhoneNumber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");
  const last4 = digits.slice(-4) || "????";
  return `***-***-${last4}`;
}

export function createPendingReceipt(db: Database, input: {
  eventDedupeKey: string;
  eventSource: string;
  eventType: string;
  eventTitle: string;
  profileId: number;
  profilePhoneNumberId?: number | null;
  templateId: number | null;
  templateRevision: number | null;
  renderedBody: string | null;
  renderContext: Record<string, string> | Record<string, unknown>;
  destinationMasked: string;
  mediaScopeKey?: string | null;
}): MessageReceipt | null {
  const now = new Date().toISOString();
  try {
    db.query(
      `
      INSERT INTO message_receipts (
        event_dedupe_key, event_source, event_type, event_title, profile_id,
        profile_phone_number_id, channel, provider, template_id, template_revision, rendered_body,
        render_context_json, destination_masked, media_scope_key, submission_status, delivery_status,
        attempted_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'sms', 'textbelt', ?, ?, ?, ?, ?, ?, 'pending', 'unknown', ?, ?, ?)
    `,
      [
        input.eventDedupeKey,
        input.eventSource,
        input.eventType,
        input.eventTitle,
        input.profileId,
        input.profilePhoneNumberId ?? null,
        input.templateId,
        input.templateRevision,
        input.renderedBody,
        JSON.stringify(sanitizeMetadata(input.renderContext)),
        input.destinationMasked,
        input.mediaScopeKey ?? null,
        now,
        now,
        now,
      ],
    );
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) return null;
    throw error;
  }
  const id = Number(firstRow(db, "SELECT last_insert_rowid()")?.[0]);
  return getReceipt(db, id);
}

/**
 * True when this profile already has a receipt that actually went out (or may have gone out) for
 * the same media scope (a specific movie, or a specific season of a series). Used to enforce
 * "never send a second SMS to the same recipient about the same movie/season" regardless of which
 * event type (grab/import/request/available/...) triggers the send.
 */
export function hasMediaScopeNotification(
  db: Database,
  profileId: number,
  mediaScopeKey: string,
): boolean {
  const row = firstRow(
    db,
    `
    SELECT 1 FROM message_receipts
    WHERE profile_id = ? AND media_scope_key = ? AND channel = 'sms'
      AND submission_status IN ('submitted', 'submission_unknown')
    LIMIT 1
  `,
    [profileId, mediaScopeKey],
  );
  return row !== null;
}

export function markReceiptSkipped(db: Database, receiptId: number, reason: string): void {
  updateReceipt(db, receiptId, {
    submission_status: "skipped",
    delivery_status: "not_applicable",
    provider_error: reason,
  });
}

export function markReceiptRenderFailed(
  db: Database,
  receiptId: number,
  errors: string[],
  context: Record<string, unknown>,
): void {
  updateReceipt(db, receiptId, {
    submission_status: "render_failed",
    delivery_status: "not_applicable",
    provider_error: errors.join("; "),
    provider_response_json: JSON.stringify(sanitizeMetadata({ errors, ...context })),
  });
}

export function markReceiptSubmitted(db: Database, receiptId: number, input: {
  providerMessageId: string | null;
  quotaRemaining: number | null;
  response: Record<string, unknown>;
}): void {
  updateReceipt(db, receiptId, {
    submission_status: "submitted",
    delivery_status: "sending",
    provider_message_id: input.providerMessageId,
    quota_remaining: input.quotaRemaining,
    provider_response_json: JSON.stringify(sanitizeMetadata(input.response)),
    submitted_at: new Date().toISOString(),
  });
}

export function markReceiptRejected(db: Database, receiptId: number, input: {
  error: string;
  quotaRemaining: number | null;
  response: Record<string, unknown>;
}): void {
  updateReceipt(db, receiptId, {
    submission_status: "rejected",
    delivery_status: "not_applicable",
    provider_error: input.error,
    quota_remaining: input.quotaRemaining,
    provider_response_json: JSON.stringify(sanitizeMetadata(input.response)),
  });
}

export function markReceiptSubmissionUnknown(db: Database, receiptId: number, input: {
  error: string;
  response?: Record<string, unknown>;
}): void {
  updateReceipt(db, receiptId, {
    submission_status: "submission_unknown",
    delivery_status: "unknown",
    provider_error: input.error,
    provider_response_json: JSON.stringify(
      sanitizeMetadata(input.response ?? { error: input.error }),
    ),
  });
}

export function updateReceiptDeliveryStatus(db: Database, receiptId: number, input: {
  deliveryStatus: DeliveryStatus;
  response: Record<string, unknown>;
  deliveredAt?: string | null;
}): void {
  updateReceipt(db, receiptId, {
    delivery_status: input.deliveryStatus,
    last_status_check_at: new Date().toISOString(),
    delivered_at: input.deliveredAt ??
      (input.deliveryStatus === "delivered" ? new Date().toISOString() : null),
    provider_response_json: JSON.stringify(sanitizeMetadata(input.response)),
  });
}

export function listReceipts(db: Database, query: string, limit = 100): MessageReceipt[] {
  const params: SqlValue[] = [];
  const trimmed = query.trim().toLowerCase();
  let where = "";
  if (trimmed) {
    const pattern = `%${trimmed}%`;
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    where = `WHERE lower(COALESCE(mr.event_title, '')) LIKE ?
      OR lower(COALESCE(mr.event_source, '')) LIKE ?
      OR lower(COALESCE(mr.event_type, '')) LIKE ?
      OR lower(COALESCE(np.display_name, '')) LIKE ?
      OR lower(COALESCE(mr.destination_masked, '')) LIKE ?
      OR lower(COALESCE(mr.provider_message_id, '')) LIKE ?`;
  }
  params.push(limit);
  return [
    ...db.query(
      `${receiptSelectSql()} ${where} ORDER BY mr.created_at DESC, mr.id DESC LIMIT ?`,
      params,
    ),
  ].map(mapReceipt);
}

export function getReceipt(db: Database, id: number): MessageReceipt | null {
  const row = firstRow(db, `${receiptSelectSql()} WHERE mr.id = ?`, [id]);
  return row ? mapReceipt(row) : null;
}

export function listReceiptsForStatusPolling(db: Database, limit = 20): MessageReceipt[] {
  return [...db.query(
    `${receiptSelectSql()}
    WHERE mr.provider = 'textbelt'
      AND mr.provider_message_id IS NOT NULL
      AND mr.delivery_status NOT IN ('delivered', 'failed')
      AND mr.submission_status = 'submitted'
      AND datetime(mr.created_at) >= datetime('now', '-30 days')
      AND (mr.last_status_check_at IS NULL OR datetime(mr.last_status_check_at) <= datetime('now', '-10 minutes'))
    ORDER BY COALESCE(mr.last_status_check_at, mr.created_at) ASC
    LIMIT ?`,
    [limit],
  )].map(mapReceipt);
}

export function listReceiptsForProfilePhone(
  db: Database,
  profileId: number,
  phoneNumberId: number,
  limit = 50,
): MessageReceipt[] {
  return [...db.query(
    `${receiptSelectSql()}
    WHERE mr.profile_id = ? AND mr.profile_phone_number_id = ?
    ORDER BY mr.created_at DESC, mr.id DESC
    LIMIT ?`,
    [profileId, phoneNumberId, limit],
  )].map(mapReceipt);
}

function receiptSelectSql(): string {
  return `
    SELECT mr.id, mr.event_dedupe_key, mr.event_source, mr.event_type, mr.event_title,
      mr.profile_id, np.display_name, mr.profile_phone_number_id, mr.channel, mr.provider,
      mr.template_id, mr.template_revision, mr.rendered_body, mr.render_context_json,
      mr.destination_masked, mr.provider_message_id, mr.submission_status, mr.delivery_status,
      mr.provider_error, mr.provider_response_json, mr.quota_remaining, mr.attempted_at,
      mr.submitted_at, mr.last_status_check_at, mr.delivered_at, mr.created_at, mr.updated_at
    FROM message_receipts mr
    LEFT JOIN notification_profiles np ON np.id = mr.profile_id`;
}

function updateReceipt(db: Database, receiptId: number, fields: Record<string, SqlValue>): void {
  const assignments = Object.keys(fields).map((key) => `${key} = ?`);
  const values = Object.values(fields);
  assignments.push("updated_at = ?");
  values.push(new Date().toISOString(), receiptId);
  db.query(`UPDATE message_receipts SET ${assignments.join(", ")} WHERE id = ?`, values);
}

function sanitizeMetadata(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeMetadata);
  if (typeof value === "object" && value) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 50)) {
      result[key] = /(key|token|secret|authorization|phone|email|destination)/i.test(key)
        ? "[redacted]"
        : sanitizeMetadata(nested);
    }
    return result;
  }
  return String(value);
}

function mapReceipt(row: unknown[]): MessageReceipt {
  return {
    id: Number(row[0]),
    eventDedupeKey: nullableString(row[1]),
    eventSource: nullableString(row[2]),
    eventType: nullableString(row[3]),
    eventTitle: nullableString(row[4]),
    profileId: row[5] === null ? null : Number(row[5]),
    profileName: nullableString(row[6]),
    profilePhoneNumberId: row[7] === null ? null : Number(row[7]),
    channel: String(row[8]),
    provider: nullableString(row[9]),
    templateId: row[10] === null ? null : Number(row[10]),
    templateRevision: row[11] === null ? null : Number(row[11]),
    renderedBody: nullableString(row[12]),
    renderContext: parseJson(row[13]),
    destinationMasked: nullableString(row[14]),
    providerMessageId: nullableString(row[15]),
    submissionStatus: String(row[16]) as SubmissionStatus,
    deliveryStatus: String(row[17]) as DeliveryStatus,
    providerError: nullableString(row[18]),
    providerResponse: parseJson(row[19]),
    quotaRemaining: row[20] === null ? null : Number(row[20]),
    attemptedAt: String(row[21]),
    submittedAt: nullableString(row[22]),
    lastStatusCheckAt: nullableString(row[23]),
    deliveredAt: nullableString(row[24]),
    createdAt: String(row[25]),
    updatedAt: String(row[26]),
  };
}

function nullableString(value: unknown): string | null {
  return value === null ? null : String(value);
}

function parseJson(value: unknown): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return { value: String(value) };
  }
}
