import type { Context } from "@hono/hono";
import type { Database, PublicUser } from "../db/index.ts";
import { findUserById, firstRow } from "../db/index.ts";
import { getCookieSecure, getSessionTtlDays } from "./config.ts";

export const sessionCookieName = "observarr_session";

const tokenBytes = 32;
const textEncoder = new TextEncoder();

export type SessionUser = PublicUser;

export async function createSession(
  db: Database,
  userId: number,
): Promise<{ token: string; expiresAt: string; maxAgeSeconds: number }> {
  deleteExpiredSessions(db);

  const token = randomBase64Url(tokenBytes);
  const tokenHash = await hashSessionToken(token);
  const now = new Date();
  const maxAgeSeconds = getSessionTtlDays() * 24 * 60 * 60;
  const expiresAt = new Date(now.getTime() + maxAgeSeconds * 1000).toISOString();

  db.query(
    `
      INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    [userId, tokenHash, now.toISOString(), expiresAt, now.toISOString()],
  );

  return { token, expiresAt, maxAgeSeconds };
}

export async function getSessionUser(
  db: Database,
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) {
    return null;
  }

  deleteExpiredSessions(db);

  const tokenHash = await hashSessionToken(token);
  const now = new Date().toISOString();
  const row = firstRow(
    db,
    `
      SELECT user_id
      FROM sessions
      WHERE token_hash = ? AND expires_at > ?
    `,
    [tokenHash, now],
  );

  if (!row) {
    return null;
  }

  const userId = Number(row[0]);
  const user = findUserById(db, userId);

  if (!user) {
    return null;
  }

  db.query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", [now, tokenHash]);
  return user;
}

export async function deleteSessionByToken(db: Database, token: string | undefined): Promise<void> {
  if (!token) {
    return;
  }

  const tokenHash = await hashSessionToken(token);
  db.query("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
}

export function deleteExpiredSessions(db: Database): void {
  db.query("DELETE FROM sessions WHERE expires_at <= ?", [new Date().toISOString()]);
}

export function getSessionTokenFromRequest(c: Context): string | undefined {
  const cookieHeader = c.req.header("cookie");

  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");

    if (rawName === sessionCookieName) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return undefined;
}

export function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    getCookieSecure() ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function buildClearSessionCookie(): string {
  return [
    `${sessionCookieName}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    getCookieSecure() ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

function randomBase64Url(length: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
