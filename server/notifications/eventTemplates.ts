import type { Database } from "../db/index.ts";
import { firstRow } from "../db/index.ts";
import { getCatalogEvent, isCatalogEvent, templateCatalog } from "./templateCatalog.ts";
import { renderTemplate, validateTemplate } from "./templateRenderer.ts";

export type EventTemplateRecord = {
  id: number;
  source: string;
  eventType: string;
  smsBodyTemplate: string | null;
  emailSubjectTemplate: string | null;
  emailBodyTemplate: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export class TemplateValidationError extends Error {
  status = 400;
  errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.errors = errors;
  }
}

export function seedDefaultEventTemplates(db: Database): void {
  const now = new Date().toISOString();
  for (const item of templateCatalog) {
    const existing = firstRow(
      db,
      "SELECT id FROM event_templates WHERE source = ? AND event_type = ?",
      [item.source, item.eventType],
    );
    if (existing) {
      continue;
    }
    db.query(
      `
      INSERT INTO event_templates (
        source, event_type, sms_body_template, email_subject_template,
        email_body_template, revision, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `,
      [
        item.source,
        item.eventType,
        item.defaultSmsTemplate,
        item.defaultEmailSubjectTemplate,
        item.defaultEmailBodyTemplate,
        now,
        now,
      ],
    );
  }
}

export function listEventTemplates(db: Database): EventTemplateRecord[] {
  return [...db.query(`
    SELECT id, source, event_type, sms_body_template, email_subject_template,
      email_body_template, revision, created_at, updated_at
    FROM event_templates
    ORDER BY source ASC, event_type ASC
  `)].map(mapTemplate);
}

export function getEventTemplate(
  db: Database,
  source: string,
  eventType: string,
): EventTemplateRecord | null {
  const row = firstRow(
    db,
    `
    SELECT id, source, event_type, sms_body_template, email_subject_template,
      email_body_template, revision, created_at, updated_at
    FROM event_templates
    WHERE source = ? AND event_type = ?
  `,
    [source, eventType],
  );
  return row ? mapTemplate(row) : null;
}

export function getOrCreateEventTemplate(
  db: Database,
  source: string,
  eventType: string,
): EventTemplateRecord {
  assertCatalogEvent(source, eventType);
  const existing = getEventTemplate(db, source, eventType);
  if (existing) {
    return existing;
  }
  const catalog = getCatalogEvent(source, eventType);
  if (!catalog) {
    throw new TemplateValidationError(["Unknown event template catalog entry"]);
  }
  const now = new Date().toISOString();
  db.query(
    `
    INSERT INTO event_templates (
      source, event_type, sms_body_template, email_subject_template,
      email_body_template, revision, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `,
    [
      source,
      eventType,
      catalog.defaultSmsTemplate,
      catalog.defaultEmailSubjectTemplate,
      catalog.defaultEmailBodyTemplate,
      now,
      now,
    ],
  );
  return getEventTemplate(db, source, eventType)!;
}

export function updateEventTemplate(
  db: Database,
  source: string,
  eventType: string,
  input: {
    smsBodyTemplate?: unknown;
    emailSubjectTemplate?: unknown;
    emailBodyTemplate?: unknown;
  },
): EventTemplateRecord {
  assertCatalogEvent(source, eventType);
  const current = getOrCreateEventTemplate(db, source, eventType);
  const smsBodyTemplate = normalizeTemplateInput(input.smsBodyTemplate, current.smsBodyTemplate);
  const emailSubjectTemplate = normalizeTemplateInput(
    input.emailSubjectTemplate,
    current.emailSubjectTemplate,
  );
  const emailBodyTemplate = normalizeTemplateInput(
    input.emailBodyTemplate,
    current.emailBodyTemplate,
  );
  validateTemplateSet(source, eventType, smsBodyTemplate, emailSubjectTemplate, emailBodyTemplate);
  const now = new Date().toISOString();

  db.query(
    `
    UPDATE event_templates
    SET sms_body_template = ?, email_subject_template = ?, email_body_template = ?,
      revision = revision + 1, updated_at = ?
    WHERE id = ?
  `,
    [smsBodyTemplate, emailSubjectTemplate, emailBodyTemplate, now, current.id],
  );

  return getEventTemplate(db, source, eventType)!;
}

export function resetEventTemplate(
  db: Database,
  source: string,
  eventType: string,
): EventTemplateRecord {
  assertCatalogEvent(source, eventType);
  const current = getOrCreateEventTemplate(db, source, eventType);
  const catalog = getCatalogEvent(source, eventType)!;
  const now = new Date().toISOString();
  db.query(
    `
    UPDATE event_templates
    SET sms_body_template = ?, email_subject_template = ?, email_body_template = ?,
      revision = revision + 1, updated_at = ?
    WHERE id = ?
  `,
    [
      catalog.defaultSmsTemplate,
      catalog.defaultEmailSubjectTemplate,
      catalog.defaultEmailBodyTemplate,
      now,
      current.id,
    ],
  );
  return getEventTemplate(db, source, eventType)!;
}

export function previewEventTemplate(
  db: Database,
  source: string,
  eventType: string,
  input?: {
    smsBodyTemplate?: unknown;
    emailSubjectTemplate?: unknown;
    emailBodyTemplate?: unknown;
    context?: unknown;
  },
) {
  assertCatalogEvent(source, eventType);
  const template = getOrCreateEventTemplate(db, source, eventType);
  const catalog = getCatalogEvent(source, eventType)!;
  const context = {
    ...catalog.sampleContext,
    ...(isObject(input?.context) ? stringContext(input.context) : {}),
  };
  const smsBodyTemplate = normalizeTemplateInput(input?.smsBodyTemplate, template.smsBodyTemplate);
  const emailSubjectTemplate = normalizeTemplateInput(
    input?.emailSubjectTemplate,
    template.emailSubjectTemplate,
  );
  const emailBodyTemplate = normalizeTemplateInput(
    input?.emailBodyTemplate,
    template.emailBodyTemplate,
  );
  const sms = renderTemplate(source, eventType, smsBodyTemplate, context);
  const emailSubject = renderTemplate(source, eventType, emailSubjectTemplate, context);
  const emailBody = renderTemplate(source, eventType, emailBodyTemplate, context);

  return {
    sms,
    emailSubject,
    emailBody,
    context,
  };
}

export function validateTemplateSet(
  source: string,
  eventType: string,
  smsBodyTemplate: string | null,
  emailSubjectTemplate: string | null,
  emailBodyTemplate: string | null,
): void {
  const errors = [
    ...validateTemplate(source, eventType, smsBodyTemplate).errors,
    ...validateTemplate(source, eventType, emailSubjectTemplate).errors,
    ...validateTemplate(source, eventType, emailBodyTemplate).errors,
  ];
  if (smsBodyTemplate !== null && smsBodyTemplate.trim().length === 0) {
    errors.push("SMS template cannot be blank when configured.");
  }
  if (errors.length > 0) {
    throw new TemplateValidationError(errors);
  }
}

export function catalogWithTemplateSummaries(db: Database) {
  const templates = new Map(
    listEventTemplates(db).map((
      template,
    ) => [`${template.source}:${template.eventType}`, template]),
  );
  return templateCatalog.map((item) => {
    const template = templates.get(`${item.source}:${item.eventType}`);
    return {
      ...item,
      template: template
        ? {
          id: template.id,
          revision: template.revision,
          hasSmsTemplate: Boolean(template.smsBodyTemplate),
          hasEmailSubjectTemplate: Boolean(template.emailSubjectTemplate),
          hasEmailBodyTemplate: Boolean(template.emailBodyTemplate),
          updatedAt: template.updatedAt,
        }
        : null,
    };
  });
}

function assertCatalogEvent(source: string, eventType: string): void {
  if (!isCatalogEvent(source, eventType)) {
    throw new TemplateValidationError([`Unknown event type ${source}:${eventType}`]);
  }
}

function normalizeTemplateInput(value: unknown, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TemplateValidationError(["Template value must be a string or null"]);
  }
  return value;
}

function stringContext(context: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

function mapTemplate(row: unknown[]): EventTemplateRecord {
  return {
    id: Number(row[0]),
    source: String(row[1]),
    eventType: String(row[2]),
    smsBodyTemplate: row[3] === null ? null : String(row[3]),
    emailSubjectTemplate: row[4] === null ? null : String(row[4]),
    emailBodyTemplate: row[5] === null ? null : String(row[5]),
    revision: Number(row[6]),
    createdAt: String(row[7]),
    updatedAt: String(row[8]),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
