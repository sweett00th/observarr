import type { Database } from "../../db/index.ts";
import {
  createImportedProfile,
  ensureAvatarDirectory,
  findIdentity,
  getAvatarFilePath,
  updateProfileAvatar,
  upsertExternalIdentity,
} from "../../notifications/profiles.ts";
import { fetchJellyfinPrimaryAvatar, fetchJellyfinUsers } from "./client.ts";

export type JellyfinImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  avatarsFetched: number;
  avatarFailures: number;
  warnings: string[];
};

export async function importJellyfinUsers(db: Database): Promise<JellyfinImportSummary> {
  const users = await fetchJellyfinUsers();
  const summary: JellyfinImportSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    avatarsFetched: 0,
    avatarFailures: 0,
    warnings: [],
  };

  await ensureAvatarDirectory();

  for (const user of users) {
    let profileId: number;
    const syncedAt = new Date().toISOString();

    try {
      db.execute("BEGIN");
      const existingIdentity = findIdentity(db, "jellyfin", user.id);

      if (existingIdentity) {
        profileId = existingIdentity.profileId;
        upsertExternalIdentity(db, {
          profileId,
          provider: "jellyfin",
          externalUserId: user.id,
          username: user.username,
          email: user.email,
          lastSyncedAt: syncedAt,
        });
        summary.updated += 1;
      } else {
        profileId = createImportedProfile(db, user.username, user.email);
        upsertExternalIdentity(db, {
          profileId,
          provider: "jellyfin",
          externalUserId: user.id,
          username: user.username,
          email: user.email,
          lastSyncedAt: syncedAt,
        });
        summary.created += 1;
      }

      db.execute("COMMIT");
    } catch (error) {
      db.execute("ROLLBACK");
      summary.skipped += 1;
      summary.warnings.push(`Skipped Jellyfin user ${user.username}: ${safeErrorMessage(error)}`);
      continue;
    }

    if (!user.hasPrimaryAvatar) {
      continue;
    }

    try {
      const avatar = await fetchJellyfinPrimaryAvatar(user.id);
      if (!avatar) {
        continue;
      }

      const filename = avatarFilename(profileId, user.id, avatar.contentType);
      await Deno.writeFile(getAvatarFilePath(filename), avatar.bytes);
      updateProfileAvatar(db, profileId, filename, avatar.contentType);
      summary.avatarsFetched += 1;
    } catch (error) {
      summary.avatarFailures += 1;
      summary.warnings.push(
        `Avatar import failed for Jellyfin user ${user.username}: ${safeErrorMessage(error)}`,
      );
    }
  }

  return summary;
}

function avatarFilename(profileId: number, jellyfinUserId: string, contentType: string): string {
  const extension = contentType === "image/png"
    ? "png"
    : contentType === "image/webp"
    ? "webp"
    : "jpg";
  const safeUserId = jellyfinUserId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "user";
  return `profile-${profileId}-jellyfin-${safeUserId}.${extension}`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Import failed";
}
