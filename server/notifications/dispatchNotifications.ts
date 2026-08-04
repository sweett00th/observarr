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
import { getMediaInterestTargetForItem, profileHasMediaInterest } from "./mediaInterests.ts";
import type { NotificationProfile } from "./profiles.ts";
import {
  createPendingReceipt,
  hasMediaScopeNotification,
  markReceiptRejected,
  markReceiptRenderFailed,
  markReceiptSkipped,
  markReceiptSubmissionUnknown,
  markReceiptSubmitted,
  maskPhoneNumber,
} from "./receiptService.ts";
import { renderTemplate } from "./templateRenderer.ts";

type EligibleProfile = NotificationProfile & {
  preferenceId: number;
  phoneNumberId: number;
  dispatchPhoneNumber: string;
};

type SmsEligibilitySummary = {
  subscriptionRows: number;
  enabledProfiles: number;
  withPhone: number;
  optedIn: number;
  optedOut: number;
  eligible: number;
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
  optionsOrClient: { client?: TextbeltClient; mediaItemId?: number | null } | TextbeltClient = {},
): Promise<DispatchSummary> {
  const options = "sendSms" in optionsOrClient ? { client: optionsOrClient } : optionsOrClient;
  const client = options.client ?? createTextbeltClient();
  const summary: DispatchSummary = {
    attempted: 0,
    submitted: 0,
    rejected: 0,
    renderFailed: 0,
    submissionUnknown: 0,
    skipped: 0,
  };

  if (event.source === "test") {
    logNotification("info", "notifications.dispatch.skipped", {
      reason: "test_event",
      eventId: event.id,
      source: event.source,
      rawEventType: event.eventType,
    });
    return summary;
  }

  if (!notificationsEnabled()) {
    logNotification("info", "notifications.dispatch.skipped", {
      reason: "notifications_disabled",
      eventId: event.id,
      source: event.source,
      rawEventType: event.eventType,
    });
    return summary;
  }

  const canonical = buildCanonicalEventContext(event);
  if (!canonical) {
    logNotification("warn", "notifications.dispatch.skipped", {
      reason: "event_not_in_catalog",
      eventId: event.id,
      source: event.source,
      rawEventType: event.eventType,
    });
    return summary;
  }

  // Overwrite media fields from the canonical media_items record — it aggregates data
  // across all source events and is more reliable than any single payload
  if (options.mediaItemId != null) {
    Object.assign(
      canonical.templateContext,
      mediaItemTemplateContext(db, options.mediaItemId),
    );
  }

  logNotification("info", "notifications.dispatch.started", {
    eventId: event.id,
    source: canonical.source,
    eventType: canonical.eventType,
    dedupeKey: canonical.eventDedupeKey,
  });

  const mediaTarget = getMediaInterestTargetForItem(db, options.mediaItemId);
  const profiles = listEligibleSmsProfiles(db, canonical.source, canonical.eventType)
    .filter((profile) => !mediaTarget || profileHasMediaInterest(db, profile.id, mediaTarget));

  // Scopes dedupe to a single movie, or a single season of a series, regardless of which event
  // type (grab/import/request/available/...) is driving the send. Null when the event has no
  // resolved media (health checks, auth failures, opt-in welcome texts, etc.) — those aren't
  // "about a movie" so the one-SMS-per-media rule doesn't apply to them.
  const mediaScopeKey = buildMediaScopeKey(
    options.mediaItemId,
    canonical.templateContext.seasonNumber,
  );

  if (profiles.length === 0) {
    logNotification("info", "notifications.dispatch.no_eligible_profiles", {
      eventId: event.id,
      source: canonical.source,
      eventType: canonical.eventType,
      ...getSmsEligibilitySummary(db, canonical.source, canonical.eventType),
      mediaInterestRequired: Boolean(mediaTarget),
    });
    return summary;
  }

  logNotification("info", "notifications.dispatch.eligible_profiles", {
    eventId: event.id,
    source: canonical.source,
    eventType: canonical.eventType,
    eligibleProfiles: profiles.length,
  });

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
      profilePhoneNumberId: profile.phoneNumberId,
      templateId: template.id,
      templateRevision: template.revision,
      renderedBody: null,
      renderContext: profileContext.templateContext,
      destinationMasked: maskPhoneNumber(profile.dispatchPhoneNumber),
      mediaScopeKey,
    });

    if (!receipt) {
      summary.skipped += 1;
      logNotification("info", "notifications.dispatch.receipt_skipped", {
        reason: "duplicate_event_profile_channel",
        eventId: event.id,
        profileId: profile.id,
        phoneNumberId: profile.phoneNumberId,
        source: canonical.source,
        eventType: canonical.eventType,
        dedupeKey: canonical.eventDedupeKey,
      });
      continue;
    }

    if (mediaScopeKey && hasMediaScopeNotification(db, profile.id, mediaScopeKey)) {
      markReceiptSkipped(
        db,
        receipt.id,
        "Recipient already received an SMS about this movie/season.",
      );
      summary.skipped += 1;
      logNotification("info", "notifications.dispatch.receipt_skipped", {
        reason: "duplicate_media_recipient",
        eventId: event.id,
        receiptId: receipt.id,
        profileId: profile.id,
        phoneNumberId: profile.phoneNumberId,
        source: canonical.source,
        eventType: canonical.eventType,
        mediaScopeKey,
      });
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
      logNotification("warn", "notifications.dispatch.render_failed", {
        eventId: event.id,
        receiptId: receipt.id,
        profileId: profile.id,
        phoneNumberId: profile.phoneNumberId,
        source: canonical.source,
        eventType: canonical.eventType,
        missingVariables: rendered.missingVariables,
      });
      continue;
    }

    db.query("UPDATE message_receipts SET rendered_body = ?, updated_at = ? WHERE id = ?", [
      rendered.rendered,
      new Date().toISOString(),
      receipt.id,
    ]);

    try {
      const result = await client.sendSms(profile.dispatchPhoneNumber, rendered.rendered);
      if (result.kind === "submitted") {
        markReceiptSubmitted(db, receipt.id, {
          providerMessageId: result.textId,
          quotaRemaining: result.quotaRemaining,
          response: result.response,
        });
        summary.submitted += 1;
        logNotification("info", "notifications.dispatch.submitted", {
          eventId: event.id,
          receiptId: receipt.id,
          profileId: profile.id,
          phoneNumberId: profile.phoneNumberId,
          source: canonical.source,
          eventType: canonical.eventType,
          provider: "textbelt",
          providerMessageId: result.textId,
          quotaRemaining: result.quotaRemaining,
        });
      } else if (result.kind === "rejected") {
        markReceiptRejected(db, receipt.id, {
          error: result.error,
          quotaRemaining: result.quotaRemaining,
          response: result.response,
        });
        summary.rejected += 1;
        logNotification("warn", "notifications.dispatch.rejected", {
          eventId: event.id,
          receiptId: receipt.id,
          profileId: profile.id,
          phoneNumberId: profile.phoneNumberId,
          source: canonical.source,
          eventType: canonical.eventType,
          provider: "textbelt",
          error: result.error,
          quotaRemaining: result.quotaRemaining,
        });
      } else {
        markReceiptSubmissionUnknown(db, receipt.id, {
          error: result.error,
          response: result.response,
        });
        summary.submissionUnknown += 1;
        logNotification("warn", "notifications.dispatch.submission_unknown", {
          eventId: event.id,
          receiptId: receipt.id,
          profileId: profile.id,
          phoneNumberId: profile.phoneNumberId,
          source: canonical.source,
          eventType: canonical.eventType,
          provider: "textbelt",
          error: result.error,
        });
      }
    } catch (error) {
      if (error instanceof TextbeltConfigurationError) {
        markReceiptRejected(db, receipt.id, {
          error: error.message,
          quotaRemaining: null,
          response: { configured: false },
        });
        summary.rejected += 1;
        logNotification("warn", "notifications.dispatch.rejected", {
          eventId: event.id,
          receiptId: receipt.id,
          profileId: profile.id,
          phoneNumberId: profile.phoneNumberId,
          source: canonical.source,
          eventType: canonical.eventType,
          provider: "textbelt",
          error: error.message,
        });
      } else {
        const message = error instanceof Error
          ? error.message
          : "SMS submission failed ambiguously";
        markReceiptSubmissionUnknown(db, receipt.id, { error: message });
        summary.submissionUnknown += 1;
        logNotification("error", "notifications.dispatch.submission_unknown", {
          eventId: event.id,
          receiptId: receipt.id,
          profileId: profile.id,
          phoneNumberId: profile.phoneNumberId,
          source: canonical.source,
          eventType: canonical.eventType,
          provider: "textbelt",
          error: message,
        });
      }
    }
  }

  logNotification("info", "notifications.dispatch.finished", {
    eventId: event.id,
    source: canonical.source,
    eventType: canonical.eventType,
    ...summary,
  });
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
      np.avatar_filename, np.avatar_content_type, pnp.opted_in_at, pnp.opted_out_at,
      np.created_at, np.updated_at, pep.id, pnp.id, pnp.phone_number
    FROM notification_profiles np
    JOIN profile_event_preferences pep ON pep.profile_id = np.id
    JOIN notification_profile_phone_numbers pnp ON pnp.profile_id = np.id
    WHERE np.enabled = 1
      AND pnp.enabled = 1
      AND pnp.phone_number IS NOT NULL
      AND pnp.opted_in_at IS NOT NULL
      AND pnp.opted_out_at IS NULL
      AND pep.source = ?
      AND pep.event_type = ?
      AND pep.enabled = 1
      AND pep.notify_sms = 1
    ORDER BY np.id ASC, pnp.id ASC
  `,
    [source, eventType],
  )].map((row) => ({
    id: Number(row[0]),
    displayName: String(row[1]),
    enabled: Number(row[2]) === 1,
    phoneNumber: row[3] === null ? null : String(row[3]),
    emailAddress: row[4] === null ? null : String(row[4]),
    avatarFilename: row[5] === null ? null : String(row[5]),
    avatarContentType: row[6] === null ? null : String(row[6]),
    smsOptedInAt: row[7] === null ? null : String(row[7]),
    smsOptedOutAt: row[8] === null ? null : String(row[8]),
    createdAt: String(row[9]),
    updatedAt: String(row[10]),
    preferenceId: Number(row[11]),
    phoneNumberId: Number(row[12]),
    dispatchPhoneNumber: String(row[13]),
  }));
}

function getSmsEligibilitySummary(
  db: Database,
  source: string,
  eventType: string,
): SmsEligibilitySummary {
  const row = [...db.query(
    `
    SELECT
      COUNT(*),
      SUM(CASE WHEN np.enabled = 1 THEN 1 ELSE 0 END),
      SUM(CASE WHEN np.enabled = 1 AND pnp.phone_number IS NOT NULL THEN 1 ELSE 0 END),
      SUM(CASE WHEN np.enabled = 1 AND pnp.phone_number IS NOT NULL AND pnp.opted_in_at IS NOT NULL THEN 1 ELSE 0 END),
      SUM(CASE WHEN np.enabled = 1 AND pnp.opted_out_at IS NOT NULL THEN 1 ELSE 0 END),
      SUM(CASE WHEN np.enabled = 1 AND pnp.enabled = 1 AND pnp.phone_number IS NOT NULL AND pnp.opted_in_at IS NOT NULL AND pnp.opted_out_at IS NULL THEN 1 ELSE 0 END)
    FROM profile_event_preferences pep
    JOIN notification_profiles np ON np.id = pep.profile_id
    LEFT JOIN notification_profile_phone_numbers pnp ON pnp.profile_id = np.id
    WHERE pep.source = ?
      AND pep.event_type = ?
      AND pep.enabled = 1
      AND pep.notify_sms = 1
  `,
    [source, eventType],
  )][0] ?? [0, 0, 0, 0, 0, 0];

  return {
    subscriptionRows: Number(row[0] ?? 0),
    enabledProfiles: Number(row[1] ?? 0),
    withPhone: Number(row[2] ?? 0),
    optedIn: Number(row[3] ?? 0),
    optedOut: Number(row[4] ?? 0),
    eligible: Number(row[5] ?? 0),
  };
}

/**
 * Builds the key used to dedupe SMS sends per recipient: one key per movie, or per season of a
 * series when a season number is known (so Season 2 can still notify after Season 1 already has).
 * Episode-level events fold into their season's key on purpose — a recipient who was already
 * texted about a season shouldn't get a second text per episode within it.
 */
function buildMediaScopeKey(
  mediaItemId: number | null | undefined,
  seasonNumber: string | undefined,
): string | null {
  if (mediaItemId == null) return null;
  const season = seasonNumber?.trim();
  return season ? `media:${mediaItemId}:season:${season}` : `media:${mediaItemId}`;
}

function mediaItemTemplateContext(
  db: Database,
  id: number,
): Record<string, string> {
  const row = [...db.query(
    "SELECT title, media_type, year FROM media_items WHERE id = ?",
    [id],
  )][0];
  if (!row) return {};

  const title = row[0] != null ? String(row[0]).trim() : null;
  const mediaType = row[1] != null ? String(row[1]) : null;
  const year = row[2] != null ? String(row[2]).trim() : null;
  const patch: Record<string, string> = {};

  // Year is always authoritative from media_items — it's aggregated across all source events
  if (year) patch.mediaYear = year;

  if (mediaType === "movie") {
    // For movies, title is stable in media_items (sourced from Radarr/Seerr which carry full metadata)
    if (title) patch.mediaTitle = title;
    if (title) patch.movieTitle = title;
    if (year) patch.movieYear = year;
  }
  // For series: media_items.title is the season/episode name ("Season 3"), NOT the series name.
  // seriesTitle and mediaTitle for series events come correctly from the raw payload
  // (SeriesName → seriesTitle, Name → mediaTitle) — do not override them here.

  return patch;
}

function logNotification(
  level: "info" | "warn" | "error",
  name: string,
  fields: Record<string, unknown>,
): void {
  console[level](JSON.stringify({ event: name, at: new Date().toISOString(), ...fields }));
}
