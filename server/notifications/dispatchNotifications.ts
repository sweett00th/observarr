import type { Database } from "../db/index.ts";
import type { LiveEvent } from "../events/eventBus.ts";
import { notificationsEnabled } from "../lib/config.ts";
import {
  createTextbeltClient,
  type TextbeltClient,
  TextbeltConfigurationError,
} from "../providers/textbeltClient.ts";
import { getOrCreateEventTemplate } from "./eventTemplates.ts";
import { buildCanonicalEventContext, withProfileContext } from "./eventContext.ts";
import type { NotificationProfile } from "./profiles.ts";
import {
  createPendingReceipt,
  markReceiptRejected,
  markReceiptRenderFailed,
  markReceiptSubmissionUnknown,
  markReceiptSubmitted,
  maskPhoneNumber,
} from "./receiptService.ts";
import { renderTemplate } from "./templateRenderer.ts";

type EligibleProfile = NotificationProfile & {
  preferenceId: number;
};

export type DispatchSummary = {
  attempted: number;
  submitted: number;
  rejected: number;
  renderFailed: number;
  submissionUnknown: number;
  skipped: number;
};

export async function dispatchNotificationsForEvent(
  db: Database,
  event: LiveEvent,
  client: TextbeltClient = createTextbeltClient(),
): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    attempted: 0,
    submitted: 0,
    rejected: 0,
    renderFailed: 0,
    submissionUnknown: 0,
    skipped: 0,
  };

  if (event.source === "test" || !notificationsEnabled()) {
    return summary;
  }

  const canonical = buildCanonicalEventContext(event);
  if (!canonical) {
    return summary;
  }

  const profiles = listEligibleSmsProfiles(db, canonical.source, canonical.eventType);
  if (profiles.length === 0) {
    return summary;
  }

  const template = getOrCreateEventTemplate(db, canonical.source, canonical.eventType);

  for (const profile of profiles) {
    summary.attempted += 1;
    const profileContext = withProfileContext(canonical, profile);
    const receipt = createPendingReceipt(db, {
      eventDedupeKey: canonical.eventDedupeKey,
      eventSource: canonical.source,
      eventType: canonical.eventType,
      eventTitle: canonical.eventTitle,
      profileId: profile.id,
      templateId: template.id,
      templateRevision: template.revision,
      renderedBody: null,
      renderContext: profileContext.templateContext,
      destinationMasked: maskPhoneNumber(profile.phoneNumber!),
    });

    if (!receipt) {
      summary.skipped += 1;
      continue;
    }

    const rendered = renderTemplate(
      canonical.source,
      canonical.eventType,
      template.smsBodyTemplate,
      profileContext.templateContext,
    );

    if (!rendered.ok) {
      markReceiptRenderFailed(db, receipt.id, rendered.errors, {
        missingVariables: rendered.missingVariables,
      });
      summary.renderFailed += 1;
      continue;
    }

    db.query("UPDATE message_receipts SET rendered_body = ?, updated_at = ? WHERE id = ?", [
      rendered.rendered,
      new Date().toISOString(),
      receipt.id,
    ]);

    try {
      const result = await client.sendSms(profile.phoneNumber!, rendered.rendered);
      if (result.kind === "submitted") {
        markReceiptSubmitted(db, receipt.id, {
          providerMessageId: result.textId,
          quotaRemaining: result.quotaRemaining,
          response: result.response,
        });
        summary.submitted += 1;
      } else if (result.kind === "rejected") {
        markReceiptRejected(db, receipt.id, {
          error: result.error,
          quotaRemaining: result.quotaRemaining,
          response: result.response,
        });
        summary.rejected += 1;
      } else {
        markReceiptSubmissionUnknown(db, receipt.id, {
          error: result.error,
          response: result.response,
        });
        summary.submissionUnknown += 1;
      }
    } catch (error) {
      if (error instanceof TextbeltConfigurationError) {
        markReceiptRejected(db, receipt.id, {
          error: error.message,
          quotaRemaining: null,
          response: { configured: false },
        });
        summary.rejected += 1;
      } else {
        markReceiptSubmissionUnknown(db, receipt.id, {
          error: error instanceof Error ? error.message : "SMS submission failed ambiguously",
        });
        summary.submissionUnknown += 1;
      }
    }
  }

  return summary;
}

function listEligibleSmsProfiles(
  db: Database,
  source: string,
  eventType: string,
): EligibleProfile[] {
  return [...db.query(
    `
    SELECT np.id, np.display_name, np.enabled, np.phone_number, np.email_address,
      np.avatar_filename, np.avatar_content_type, np.sms_opted_in_at, np.sms_opted_out_at,
      np.created_at, np.updated_at, pep.id
    FROM notification_profiles np
    JOIN profile_event_preferences pep ON pep.profile_id = np.id
    WHERE np.enabled = 1
      AND np.phone_number IS NOT NULL
      AND np.sms_opted_in_at IS NOT NULL
      AND np.sms_opted_out_at IS NULL
      AND pep.source = ?
      AND pep.event_type = ?
      AND pep.enabled = 1
      AND pep.notify_sms = 1
    ORDER BY np.id ASC
  `,
    [source, eventType],
  )].map((row) => ({
    id: Number(row[0]),
    displayName: String(row[1]),
    enabled: Number(row[2]) === 1,
    phoneNumber: String(row[3]),
    emailAddress: row[4] === null ? null : String(row[4]),
    avatarFilename: row[5] === null ? null : String(row[5]),
    avatarContentType: row[6] === null ? null : String(row[6]),
    smsOptedInAt: row[7] === null ? null : String(row[7]),
    smsOptedOutAt: row[8] === null ? null : String(row[8]),
    createdAt: String(row[9]),
    updatedAt: String(row[10]),
    preferenceId: Number(row[11]),
  }));
}
