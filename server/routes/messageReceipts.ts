import { Hono } from "@hono/hono";
import type { Database } from "../db/index.ts";
import { getReceipt, listReceipts } from "../notifications/receiptService.ts";

export function createMessageReceiptRoutes(db: Database): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    const requestedLimit = Number(c.req.query("limit") ?? 100);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 500)
      : 100;

    return c.json({
      ok: true,
      receipts: listReceipts(db, c.req.query("query") ?? "", limit),
    });
  });

  routes.get("/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ ok: false, status: "bad_request", error: "Invalid message receipt id" }, 400);
    }
    const receipt = getReceipt(db, id);
    if (!receipt) {
      return c.json({ ok: false, status: "not_found", error: "Message receipt not found" }, 404);
    }
    return c.json({ ok: true, receipt });
  });

  return routes;
}
