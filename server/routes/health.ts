import { Hono } from "@hono/hono";

const health = new Hono();

health.get("/health", (c) => {
  return c.json({
    ok: true,
    status: "healthy",
    runtime: {
      name: "Deno",
      version: Deno.version.deno,
    },
  });
});

export default health;
