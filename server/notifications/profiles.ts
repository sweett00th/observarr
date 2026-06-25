import type { Database } from "../db/index.ts";
import { firstRow } from "../db/index.ts";
import { getAvatarDirectory } from "../lib/config.ts";
import { isKnownNotificationEvent } from "./eventCatalog.ts";

export type IdentityProvider = "jellyfin" | "seerr";

type SqlValue = string | number | null;

export type ProfileIdentity = {
  id: number;
  profileId: number;
  provider: IdentityProvider;
  externalUserId: string;
  username: string | null;
  email: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProfilePreference = {
  id: number;
  profileId: number;
  source: string;
  eventType: string;
  enabled: boolean;
  notifySms: boolean;
  notifyEmail: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NotificationProfile = {
  id: number;
  displayName: string;
  enabled: boolean;
  phoneNumber: string | null;
  emailAddress: string | null;
  avatarFilename: string | null;
  avatarContentType: string | null;
  smsOptedInAt: string | null;
  smsOptedOutAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProfileSummary = {
  id: number;
  displayName: string;
  enabled: boolean;
  hasAvatar: boolean;
  providers: IdentityProvider[];
  hasPhone: boolean;
  hasEmail: boolean;
  updatedAt: string;
};

export type ProfileDetails = NotificationProfile & {
  identities: ProfileIdentity[];
  preferences: ProfilePreference[];
  contactReadiness: {
    sms: boolean;
    email: boolean;
  };
};

export type ProfileInput = {
  displayName?: unknown;
  enabled?: unknown;
  phoneNumber?: unknown;
  emailAddress?: unknown;
  smsOptedIn?: unknown;
  identities?: unknown;
};

export type PreferenceInput = {
  source?: unknown;
  eventType?: unknown;
  enabled?: unknown;
  notifySms?: unknown;
  notifyEmail?: unknown;
};

export class ValidationError extends Error {
  status = 400;
}

export class ConflictError extends Error {
  status = 409;
}

export function listProfiles(db: Database, query: string): ProfileSummary[] {
  const params: SqlValue[] = [];
  const trimmedQuery = query.trim().toLowerCase();
  let where = "";

  if (trimmedQuery) {
    const pattern = `%${trimmedQuery}%`;
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    where = `
      WHERE lower(np.display_name) LIKE ?
        OR lower(COALESCE(np.email_address, '')) LIKE ?
        OR lower(COALESCE(np.phone_number, '')) LIKE ?
        OR EXISTS (
          SELECT 1 FROM profile_external_identities pei
          WHERE pei.profile_id = np.id
            AND (
              lower(COALESCE(pei.username, '')) LIKE ?
              OR lower(COALESCE(pei.email, '')) LIKE ?
              OR lower(pei.external_user_id) LIKE ?
            )
        )
    `;
  }

  return [...db.query(
    `
    SELECT np.id, np.display_name, np.enabled, np.avatar_filename,
      np.phone_number, np.email_address, np.updated_at,
      GROUP_CONCAT(pei.provider)
    FROM notification_profiles np
    LEFT JOIN profile_external_identities pei ON pei.profile_id = np.id
    ${where}
    GROUP BY np.id
    ORDER BY lower(np.display_name) ASC, np.id ASC
  `,
    params,
  )].map((row) => ({
    id: Number(row[0]),
    displayName: String(row[1]),
    enabled: Number(row[2]) === 1,
    hasAvatar: row[3] !== null,
    hasPhone: row[4] !== null && String(row[4]).length > 0,
    hasEmail: row[5] !== null && String(row[5]).length > 0,
    updatedAt: String(row[6]),
    providers: row[7] === null ? [] : String(row[7]).split(",").filter(isIdentityProvider),
  }));
}

export function getProfileDetails(db: Database, profileId: number): ProfileDetails | null {
  const profile = getProfile(db, profileId);

  if (!profile) {
    return null;
  }

  return {
    ...profile,
    identities: listIdentities(db, profileId),
    preferences: listPreferences(db, profileId),
    contactReadiness: {
      sms: Boolean(profile.phoneNumber && profile.smsOptedInAt && !profile.smsOptedOutAt),
      email: Boolean(profile.emailAddress),
    },
  };
}

export function createProfile(db: Database, input: ProfileInput): ProfileDetails {
  const normalized = normalizeProfileInput(input, { requireDisplayName: true });
  const now = new Date().toISOString();

  try {
    db.execute("BEGIN");
    db.query(
      `
      INSERT INTO notification_profiles (
        display_name, enabled, phone_number, email_address, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      [
        normalized.displayName,
        normalized.enabled ? 1 : 0,
        normalized.phoneNumber,
        normalized.emailAddress,
        now,
        now,
      ],
    );

    const profileId = Number(firstRow(db, "SELECT last_insert_rowid()")?.[0]);
    upsertIdentityInputs(db, profileId, normalized.identities, now);
    db.execute("COMMIT");

    const profile = getProfileDetails(db, profileId);
    if (!profile) {
      throw new Error("Created profile could not be loaded");
    }
    return profile;
  } catch (error) {
    db.execute("ROLLBACK");
    throw mapSqliteError(error);
  }
}

export function updateProfile(
  db: Database,
  profileId: number,
  input: ProfileInput,
): ProfileDetails | null {
  if (!getProfile(db, profileId)) {
    return null;
  }

  const normalized = normalizeProfileInput(input, { requireDisplayName: false });
  const now = new Date().toISOString();
  const assignments: string[] = [];
  const params: SqlValue[] = [];

  if (normalized.displayName !== undefined) {
    assignments.push("display_name = ?");
    params.push(normalized.displayName);
  }
  if (normalized.enabled !== undefined) {
    assignments.push("enabled = ?");
    params.push(normalized.enabled ? 1 : 0);
  }
  if (normalized.phoneNumber !== undefined) {
    assignments.push("phone_number = ?");
    params.push(normalized.phoneNumber);
  }
  if (normalized.emailAddress !== undefined) {
    assignments.push("email_address = ?");
    params.push(normalized.emailAddress);
  }
  if (normalized.smsOptedIn !== undefined) {
    assignments.push("sms_opted_in_at = ?");
    assignments.push("sms_opted_out_at = ?");
    params.push(normalized.smsOptedIn ? now : null, normalized.smsOptedIn ? null : now);
  }

  try {
    db.execute("BEGIN");

    if (assignments.length > 0) {
      assignments.push("updated_at = ?");
      params.push(now, profileId);
      db.query(`UPDATE notification_profiles SET ${assignments.join(", ")} WHERE id = ?`, params);
    }

    upsertIdentityInputs(db, profileId, normalized.identities, now);
    db.query("UPDATE notification_profiles SET updated_at = ? WHERE id = ?", [now, profileId]);
    db.execute("COMMIT");

    return getProfileDetails(db, profileId);
  } catch (error) {
    db.execute("ROLLBACK");
    throw mapSqliteError(error);
  }
}

export function replacePreferences(
  db: Database,
  profileId: number,
  preferences: PreferenceInput[],
): ProfileDetails | null {
  if (!getProfile(db, profileId)) {
    return null;
  }

  if (!Array.isArray(preferences)) {
    throw new ValidationError("Preferences must be an array");
  }

  const normalized = preferences.map(normalizePreferenceInput);
  const seen = new Set<string>();

  for (const preference of normalized) {
    const key = `${preference.source}:${preference.eventType}`;
    if (seen.has(key)) {
      throw new ValidationError(`Duplicate preference for ${key}`);
    }
    seen.add(key);
  }

  const now = new Date().toISOString();

  try {
    db.execute("BEGIN");
    db.query("DELETE FROM profile_event_preferences WHERE profile_id = ?", [profileId]);

    for (const preference of normalized) {
      db.query(
        `
        INSERT INTO profile_event_preferences (
          profile_id, source, event_type, enabled, notify_sms, notify_email, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          profileId,
          preference.source,
          preference.eventType,
          preference.enabled ? 1 : 0,
          preference.notifySms ? 1 : 0,
          preference.notifyEmail ? 1 : 0,
          now,
          now,
        ],
      );
    }

    db.query("UPDATE notification_profiles SET updated_at = ? WHERE id = ?", [now, profileId]);
    db.execute("COMMIT");
    return getProfileDetails(db, profileId);
  } catch (error) {
    db.execute("ROLLBACK");
    throw error;
  }
}

export function getProfile(db: Database, profileId: number): NotificationProfile | null {
  const row = firstRow(
    db,
    `
    SELECT id, display_name, enabled, phone_number, email_address,
      avatar_filename, avatar_content_type, sms_opted_in_at, sms_opted_out_at, created_at, updated_at
    FROM notification_profiles
    WHERE id = ?
  `,
    [profileId],
  );

  return row ? mapProfile(row) : null;
}

export function findIdentity(
  db: Database,
  provider: IdentityProvider,
  externalUserId: string,
): ProfileIdentity | null {
  const row = firstRow(
    db,
    `
    SELECT id, profile_id, provider, external_user_id, username, email,
      last_synced_at, created_at, updated_at
    FROM profile_external_identities
    WHERE provider = ? AND external_user_id = ?
  `,
    [provider, externalUserId],
  );

  return row ? mapIdentity(row) : null;
}

export function createImportedProfile(
  db: Database,
  displayName: string,
  emailAddress: string | null,
): number {
  const now = new Date().toISOString();
  db.query(
    `
    INSERT INTO notification_profiles (
      display_name, enabled, phone_number, email_address, created_at, updated_at
    )
    VALUES (?, 1, NULL, ?, ?, ?)
  `,
    [displayName, emailAddress, now, now],
  );

  return Number(firstRow(db, "SELECT last_insert_rowid()")?.[0]);
}

export function upsertExternalIdentity(db: Database, input: {
  profileId: number;
  provider: IdentityProvider;
  externalUserId: string;
  username: string | null;
  email: string | null;
  lastSyncedAt: string | null;
}): void {
  const now = new Date().toISOString();
  ensureIdentityIsAvailable(db, input.profileId, input.provider, input.externalUserId);

  const existingForProfile = firstRow(
    db,
    "SELECT id FROM profile_external_identities WHERE profile_id = ? AND provider = ?",
    [input.profileId, input.provider],
  );

  if (existingForProfile) {
    db.query(
      `
      UPDATE profile_external_identities
      SET external_user_id = ?, username = ?, email = ?, last_synced_at = ?, updated_at = ?
      WHERE id = ?
    `,
      [
        input.externalUserId,
        input.username,
        input.email,
        input.lastSyncedAt,
        now,
        Number(existingForProfile[0]),
      ],
    );
    return;
  }

  db.query(
    `
    INSERT INTO profile_external_identities (
      profile_id, provider, external_user_id, username, email, last_synced_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      input.profileId,
      input.provider,
      input.externalUserId,
      input.username,
      input.email,
      input.lastSyncedAt,
      now,
      now,
    ],
  );
}

export function updateProfileAvatar(
  db: Database,
  profileId: number,
  avatarFilename: string,
  avatarContentType: string,
): void {
  db.query(
    `
    UPDATE notification_profiles
    SET avatar_filename = ?, avatar_content_type = ?, updated_at = ?
    WHERE id = ?
  `,
    [avatarFilename, avatarContentType, new Date().toISOString(), profileId],
  );
}

export function getAvatarFilePath(filename: string): string {
  return `${getAvatarDirectory().replaceAll("\\", "/").replace(/\/+$/, "")}/${filename}`;
}

export async function ensureAvatarDirectory(): Promise<void> {
  await Deno.mkdir(getAvatarDirectory(), { recursive: true });
}

function listIdentities(db: Database, profileId: number): ProfileIdentity[] {
  return [...db.query(
    `
    SELECT id, profile_id, provider, external_user_id, username, email,
      last_synced_at, created_at, updated_at
    FROM profile_external_identities
    WHERE profile_id = ?
    ORDER BY provider ASC
  `,
    [profileId],
  )].map(mapIdentity);
}

function listPreferences(db: Database, profileId: number): ProfilePreference[] {
  return [...db.query(
    `
    SELECT id, profile_id, source, event_type, enabled, notify_sms, notify_email,
      created_at, updated_at
    FROM profile_event_preferences
    WHERE profile_id = ?
    ORDER BY source ASC, event_type ASC
  `,
    [profileId],
  )].map(mapPreference);
}

function normalizeProfileInput(input: ProfileInput, options: { requireDisplayName: boolean }) {
  const identities = isObject(input.identities) ? input.identities : {};

  const result: {
    displayName?: string;
    enabled?: boolean;
    phoneNumber?: string | null;
    emailAddress?: string | null;
    smsOptedIn?: boolean;
    identities: Partial<Record<IdentityProvider, NormalizedIdentityInput | null>>;
  } = { identities: {} };

  if (input.displayName !== undefined || options.requireDisplayName) {
    if (typeof input.displayName !== "string" || input.displayName.trim().length === 0) {
      throw new ValidationError("Display name is required");
    }
    result.displayName = input.displayName.trim();
  }

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") {
      throw new ValidationError("Enabled must be a boolean");
    }
    result.enabled = input.enabled;
  } else if (options.requireDisplayName) {
    result.enabled = true;
  }

  if (input.phoneNumber !== undefined) {
    result.phoneNumber = normalizePhoneNumber(input.phoneNumber);
  }

  if (input.emailAddress !== undefined) {
    result.emailAddress = normalizeEmailAddress(input.emailAddress, "Email address");
  }

  if (input.smsOptedIn !== undefined) {
    if (typeof input.smsOptedIn !== "boolean") {
      throw new ValidationError("SMS opt-in must be a boolean");
    }
    result.smsOptedIn = input.smsOptedIn;
  }

  for (const provider of ["jellyfin", "seerr"] as const) {
    if (provider in identities) {
      result.identities[provider] = normalizeIdentityInput(provider, identities[provider]);
    }
  }

  return result;
}

type NormalizedIdentityInput = {
  provider: IdentityProvider;
  externalUserId: string;
  username: string | null;
  email: string | null;
};

function normalizeIdentityInput(
  provider: IdentityProvider,
  input: unknown,
): NormalizedIdentityInput | null {
  if (input === null) {
    return null;
  }

  if (!isObject(input)) {
    throw new ValidationError(`${provider} identity must be an object or null`);
  }

  const externalUserId = typeof input.externalUserId === "string"
    ? input.externalUserId.trim()
    : "";
  const username = nullableTrimmedString(input.username);
  const email = provider === "seerr"
    ? normalizeEmailAddress(input.email, "Seerr email")
    : nullableTrimmedString(input.email);

  if (!externalUserId && !username && !email) {
    return null;
  }

  if (!externalUserId) {
    throw new ValidationError(`${provider} user ID is required when mapping that provider`);
  }

  return {
    provider,
    externalUserId,
    username,
    email,
  };
}

function upsertIdentityInputs(
  db: Database,
  profileId: number,
  identities: Partial<Record<IdentityProvider, NormalizedIdentityInput | null>>,
  now: string,
): void {
  for (const provider of ["jellyfin", "seerr"] as const) {
    if (!(provider in identities)) {
      continue;
    }

    const identity = identities[provider];

    if (!identity) {
      db.query("DELETE FROM profile_external_identities WHERE profile_id = ? AND provider = ?", [
        profileId,
        provider,
      ]);
      continue;
    }

    upsertExternalIdentity(db, {
      profileId,
      provider,
      externalUserId: identity.externalUserId,
      username: identity.username,
      email: identity.email,
      lastSyncedAt: provider === "jellyfin" ? now : null,
    });
  }
}

function ensureIdentityIsAvailable(
  db: Database,
  profileId: number,
  provider: IdentityProvider,
  externalUserId: string,
): void {
  const conflict = firstRow(
    db,
    `
    SELECT profile_id FROM profile_external_identities
    WHERE provider = ? AND external_user_id = ? AND profile_id <> ?
  `,
    [provider, externalUserId, profileId],
  );

  if (conflict) {
    throw new ConflictError(
      `${provider} user ID is already mapped to another notification profile`,
    );
  }
}

function normalizePreferenceInput(input: PreferenceInput) {
  if (typeof input.source !== "string" || typeof input.eventType !== "string") {
    throw new ValidationError("Preference source and eventType are required");
  }

  const source = input.source.trim();
  const eventType = input.eventType.trim();

  if (!isKnownNotificationEvent(source, eventType)) {
    throw new ValidationError(`Unknown notification event ${source}:${eventType}`);
  }

  if (
    typeof input.enabled !== "boolean" ||
    typeof input.notifySms !== "boolean" ||
    typeof input.notifyEmail !== "boolean"
  ) {
    throw new ValidationError("Preference enabled, notifySms, and notifyEmail must be booleans");
  }

  return {
    source,
    eventType,
    enabled: input.enabled,
    notifySms: input.notifySms,
    notifyEmail: input.notifyEmail,
  };
}

function normalizePhoneNumber(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ValidationError("Phone number must be a string");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!trimmed.startsWith("+")) {
    throw new ValidationError("Phone number must include a country code, for example +15555550100");
  }

  const normalized = `+${trimmed.slice(1).replace(/[\s().-]/g, "")}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new ValidationError("Phone number must be a valid E.164-style number");
  }

  return normalized;
}

function normalizeEmailAddress(value: unknown, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string`);
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new ValidationError(`${label} is not a valid email address`);
  }

  return trimmed;
}

function nullableTrimmedString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ValidationError("Expected a string value");
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapSqliteError(error: unknown): unknown {
  if (error instanceof ValidationError || error instanceof ConflictError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("UNIQUE constraint failed: profile_external_identities.provider")) {
    return new ConflictError("External identity is already mapped to another notification profile");
  }

  if (message.includes("UNIQUE constraint failed: profile_external_identities.profile_id")) {
    return new ConflictError("Profile already has an identity for that provider");
  }

  return error;
}

function mapProfile(row: unknown[]): NotificationProfile {
  return {
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
  };
}

function mapIdentity(row: unknown[]): ProfileIdentity {
  return {
    id: Number(row[0]),
    profileId: Number(row[1]),
    provider: String(row[2]) as IdentityProvider,
    externalUserId: String(row[3]),
    username: row[4] === null ? null : String(row[4]),
    email: row[5] === null ? null : String(row[5]),
    lastSyncedAt: row[6] === null ? null : String(row[6]),
    createdAt: String(row[7]),
    updatedAt: String(row[8]),
  };
}

function mapPreference(row: unknown[]): ProfilePreference {
  return {
    id: Number(row[0]),
    profileId: Number(row[1]),
    source: String(row[2]),
    eventType: String(row[3]),
    enabled: Number(row[4]) === 1,
    notifySms: Number(row[5]) === 1,
    notifyEmail: Number(row[6]) === 1,
    createdAt: String(row[7]),
    updatedAt: String(row[8]),
  };
}

function isIdentityProvider(value: string): value is IdentityProvider {
  return value === "jellyfin" || value === "seerr";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
