import { DB } from "sqlite";
import {
  getAdminPassword,
  getAdminUsername,
  getDbPath,
  getProviderStatus,
  isProviderConfigured,
} from "../lib/config.ts";
import { hashPassword } from "../lib/passwords.ts";
import { seedDefaultEventTemplates } from "../notifications/eventTemplates.ts";
import { runMigrations } from "./migrations.ts";

export type Database = DB;

export type UserRecord = {
  id: number;
  username: string;
  passwordHash: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export type PublicUser = {
  id: number;
  username: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export type OverviewCounts = {
  receipts: number;
  profiles: number;
  templates: number;
  users: number;
  mediaTimelines: number;
};

export async function initializeDatabase(): Promise<Database> {
  const dbPath = getDbPath();
  await ensureParentDirectory(dbPath);

  const db = new DB(dbPath);
  db.execute("PRAGMA foreign_keys = ON");
  runMigrations(db);
  seedDefaultEventTemplates(db);
  await bootstrapAdminUser(db);

  console.log(`SQLite database ready at ${dbPath}`);
  return db;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");

  if (separatorIndex <= 0) {
    return;
  }

  await Deno.mkdir(normalizedPath.slice(0, separatorIndex), { recursive: true });
}

async function bootstrapAdminUser(db: Database): Promise<void> {
  if (countRows(db, "users") > 0) {
    return;
  }

  const adminPassword = getAdminPassword();

  if (!adminPassword) {
    console.warn(
      "No admin user exists. Set ADMIN_PASSWORD and restart the container to bootstrap the first admin user.",
    );
    return;
  }

  const now = new Date().toISOString();
  const username = getAdminUsername();
  const passwordHash = await hashPassword(adminPassword);

  db.query(
    `
      INSERT INTO users (username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'admin', ?, ?)
    `,
    [username, passwordHash, now, now],
  );

  console.log(`Initial admin user '${username}' created.`);
}

export function getOverview(db: Database) {
  return {
    status: "online",
    counts: getOverviewCounts(db),
    providerConfigured: isProviderConfigured(),
    providerStatus: getProviderStatus(),
  };
}

export function getOverviewCounts(db: Database): OverviewCounts {
  return {
    receipts: countRows(db, "message_receipts"),
    profiles: countRows(db, "notification_profiles"),
    templates: countRows(db, "event_templates"),
    users: countRows(db, "users"),
    mediaTimelines: countRows(db, "media_items"),
  };
}

export function hasUsers(db: Database): boolean {
  return countRows(db, "users") > 0;
}

export function findUserByUsername(db: Database, username: string): UserRecord | null {
  const row = firstRow(
    db,
    [
      "SELECT id, username, password_hash, role, created_at, updated_at, last_login_at",
      "FROM users WHERE username = ?",
    ].join(" "),
    [username],
  );

  return row ? mapUserRecord(row) : null;
}

export function findUserById(db: Database, userId: number): PublicUser | null {
  const row = firstRow(
    db,
    [
      "SELECT id, username, password_hash, role, created_at, updated_at, last_login_at",
      "FROM users WHERE id = ?",
    ].join(" "),
    [userId],
  );

  return row ? toPublicUser(mapUserRecord(row)) : null;
}

export function recordUserLogin(db: Database, userId: number): void {
  const now = new Date().toISOString();
  db.query("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?", [now, now, userId]);
}

export function updateUserPassword(db: Database, userId: number, passwordHash: string): void {
  db.query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
    passwordHash,
    new Date().toISOString(),
    userId,
  ]);
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function countRows(db: Database, tableName: string): number {
  const row = firstRow(db, `SELECT COUNT(*) FROM ${tableName}`);
  return row ? Number(row[0]) : 0;
}

export function firstRow(
  db: Database,
  sql: string,
  params: Array<number | string | null> = [],
): unknown[] | null {
  for (const row of db.query(sql, params)) {
    return row;
  }

  return null;
}

function mapUserRecord(row: unknown[]): UserRecord {
  return {
    id: Number(row[0]),
    username: String(row[1]),
    passwordHash: String(row[2]),
    role: String(row[3]),
    createdAt: String(row[4]),
    updatedAt: String(row[5]),
    lastLoginAt: row[6] === null ? null : String(row[6]),
  };
}
