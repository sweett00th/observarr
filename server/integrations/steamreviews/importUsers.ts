import type { Database } from "../../db/index.ts";
import {
  createImportedProfile,
  ensureAvatarDirectory,
  findIdentity,
  getAvatarFilePath,
  getProfile,
  updateProfileAvatar,
  upsertExternalIdentity,
} from "../../notifications/profiles.ts";
import { fetchSteamAvatar, fetchSteamreviewsUsers } from "./client.ts";

export type SteamImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  avatarsFetched: number;
  avatarFailures: number;
  warnings: string[];
};

/**
 * Imports everyone who signed in to steamreviews. A Steam user already linked to a profile updates
 * that profile's Steam identity; anyone else gets a new profile of their own, which can later be
 * merged into their Jellyfin profile when it's the same person. Nobody is opted in to anything.
 */
export async function importSteamUsers(db: Database): Promise<SteamImportSummary> {
  const users = await fetchSteamreviewsUsers();
  const summary: SteamImportSummary = {
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
    const label = user.displayName ?? `Steam user ${user.steamId.slice(-4)}`;

    try {
      db.execute("BEGIN");
      const existingIdentity = findIdentity(db, "steam", user.steamId);

      if (existingIdentity) {
        profileId = existingIdentity.profileId;
        summary.updated += 1;
      } else {
        profileId = createImportedProfile(db, label, null);
        summary.created += 1;
      }

      upsertExternalIdentity(db, {
        profileId,
        provider: "steam",
        externalUserId: user.steamId,
        username: user.displayName,
        email: null,
        lastSyncedAt: syncedAt,
      });
      db.execute("COMMIT");
    } catch (error) {
      db.execute("ROLLBACK");
      summary.skipped += 1;
      summary.warnings.push(`Skipped Steam user ${label}: ${safeErrorMessage(error)}`);
      continue;
    }

    // A profile that already has a picture (e.g. from Jellyfin) keeps it.
    if (!user.avatarUrl || getProfile(db, profileId)?.avatarFilename) {
      continue;
    }

    try {
      const avatar = await fetchSteamAvatar(user.avatarUrl);
      if (!avatar) {
        continue;
      }

      const filename = avatarFilename(profileId, user.steamId, avatar.contentType);
      await Deno.writeFile(getAvatarFilePath(filename), avatar.bytes);
      updateProfileAvatar(db, profileId, filename, avatar.contentType);
      summary.avatarsFetched += 1;
    } catch (error) {
      summary.avatarFailures += 1;
      summary.warnings.push(
        `Avatar import failed for Steam user ${label}: ${safeErrorMessage(error)}`,
      );
    }
  }

  return summary;
}

function avatarFilename(profileId: number, steamId: string, contentType: string): string {
  const extension = contentType === "image/png"
    ? "png"
    : contentType === "image/webp"
    ? "webp"
    : "jpg";
  return `profile-${profileId}-steam-${steamId}.${extension}`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Import failed";
}
