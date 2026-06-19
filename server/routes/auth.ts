import { Hono } from "@hono/hono";
import {
  type Database,
  findUserByUsername,
  hasUsers,
  recordUserLogin,
  toPublicUser,
  updateUserPassword,
} from "../db/index.ts";
import { hashPassword, verifyPassword } from "../lib/passwords.ts";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  deleteSessionByToken,
  getSessionTokenFromRequest,
  getSessionUser,
} from "../lib/sessions.ts";

type LoginPayload = {
  username?: unknown;
  password?: unknown;
};

type ChangePasswordPayload = {
  currentPassword?: unknown;
  newPassword?: unknown;
};

export function createAuthRoutes(db: Database): Hono {
  const auth = new Hono();

  auth.get("/status", (c) => {
    return c.json({
      ok: true,
      hasUsers: hasUsers(db),
    });
  });

  auth.get("/me", async (c) => {
    const user = await getSessionUser(db, getSessionTokenFromRequest(c));

    if (!user) {
      return c.json(
        {
          ok: false,
          status: "unauthorized",
          error: "Authentication required",
        },
        401,
      );
    }

    return c.json({
      ok: true,
      user,
    });
  });

  auth.post("/login", async (c) => {
    let payload: LoginPayload;

    try {
      payload = await c.req.json<LoginPayload>();
    } catch {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "Expected JSON body",
        },
        400,
      );
    }

    const username = typeof payload.username === "string" ? payload.username.trim() : "";
    const password = typeof payload.password === "string" ? payload.password : "";

    if (!username || !password) {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "Username and password are required",
        },
        400,
      );
    }

    const user = findUserByUsername(db, username);

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return c.json(
        {
          ok: false,
          status: "unauthorized",
          error: "Invalid username or password",
        },
        401,
      );
    }

    const session = await createSession(db, user.id);
    recordUserLogin(db, user.id);
    c.header("Set-Cookie", buildSessionCookie(session.token, session.maxAgeSeconds));

    return c.json({
      ok: true,
      user: {
        ...toPublicUser(user),
        lastLoginAt: new Date().toISOString(),
      },
    });
  });

  auth.post("/logout", async (c) => {
    await deleteSessionByToken(db, getSessionTokenFromRequest(c));
    c.header("Set-Cookie", buildClearSessionCookie());

    return c.json({
      ok: true,
    });
  });

  auth.post("/password", async (c) => {
    const sessionUser = await getSessionUser(db, getSessionTokenFromRequest(c));

    if (!sessionUser) {
      return c.json(
        {
          ok: false,
          status: "unauthorized",
          error: "Authentication required",
        },
        401,
      );
    }

    let payload: ChangePasswordPayload;

    try {
      payload = await c.req.json<ChangePasswordPayload>();
    } catch {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "Expected JSON body",
        },
        400,
      );
    }

    const currentPassword = typeof payload.currentPassword === "string"
      ? payload.currentPassword
      : "";
    const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";

    if (!currentPassword || !newPassword) {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "Current password and new password are required",
        },
        400,
      );
    }

    if (newPassword.length < 6) {
      return c.json(
        {
          ok: false,
          status: "bad_request",
          error: "New password must be at least 6 characters",
        },
        400,
      );
    }

    const user = findUserByUsername(db, sessionUser.username);

    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      return c.json(
        {
          ok: false,
          status: "unauthorized",
          error: "Current password is incorrect",
        },
        401,
      );
    }

    updateUserPassword(db, user.id, await hashPassword(newPassword));

    return c.json({
      ok: true,
    });
  });

  return auth;
}
