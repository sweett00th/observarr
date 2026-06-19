import { Hono } from "@hono/hono";
import {
  APP_NAME,
  APP_VERSION,
  getBuildInfo,
  getEnvironment,
  isProviderConfigured,
} from "../lib/config.ts";

const admin = new Hono();

admin.get("/version", (c) => {
  return c.json({
    ok: true,
    app: APP_NAME,
    version: APP_VERSION,
    runtime: "Deno",
    environment: getEnvironment(),
    build: getBuildInfo(),
  });
});

admin.get("/admin/overview", (c) => {
  return c.json({
    ok: true,
    app: APP_NAME,
    status: "online",
    counts: {
      receipts: 0,
      profiles: 0,
      templates: 0,
    },
    providerConfigured: isProviderConfigured(),
  });
});

export default admin;
