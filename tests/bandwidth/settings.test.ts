import assert from "node:assert/strict";
import {
  defaultBandwidthSettings,
  initialControllerState,
  parseSettingsPatch,
  SqliteBandwidthStore,
} from "../../server/bandwidth/settings.ts";
import { runMigrations } from "../../server/db/migrations.ts";
import { createBandwidthAutomationRoutes } from "../../server/routes/bandwidthAutomation.ts";
import { CAP, createTestDb, harness, JELLYFIN_KEY, SABNZBD_KEY } from "./helpers.ts";

Deno.test("migrations 11 and 12 start with automation off and the documented defaults", () => {
  const db = createTestDb();
  const store = new SqliteBandwidthStore(db);

  const settings = store.getSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.throttleBytesPerSecond, CAP);
  assert.equal(settings.throttleUnit, "Mbps");
  assert.equal(settings.idlePollIntervalSeconds, 15);
  assert.equal(settings.activePollIntervalSeconds, 60);
  assert.equal(settings.recoveryGraceSeconds, 30);
  assert.equal(settings.pausedPolicy, "grace");
  assert.equal(settings.pausedGraceSeconds, 120);
  assert.ok(settings.updatedAt);
  assert.deepEqual(store.getState(), initialControllerState);
  db.close();
});

Deno.test("migration 12 moves the old 5 s default to the new intervals and keeps saved settings", () => {
  const db = createTestDb({ throughVersion: 11 });
  db.query(
    `UPDATE bandwidth_automation_settings
    SET enabled = 1, throttle_bytes_per_second = 4000000, throttle_unit = 'MBps',
      recovery_grace_seconds = 45`,
  );
  migrateQuietly(db);

  const settings = new SqliteBandwidthStore(db).getSettings();
  assert.equal(settings.idlePollIntervalSeconds, 15);
  assert.equal(settings.activePollIntervalSeconds, 60);
  assert.equal(settings.enabled, true);
  assert.equal(settings.throttleBytesPerSecond, 4_000_000);
  assert.equal(settings.throttleUnit, "MBps");
  assert.equal(settings.recoveryGraceSeconds, 45);
  db.close();
});

Deno.test("migration 12 keeps a polling interval someone changed as the idle interval", () => {
  const db = createTestDb({ throughVersion: 11 });
  db.query("UPDATE bandwidth_automation_settings SET poll_interval_seconds = 10");
  migrateQuietly(db);

  const store = new SqliteBandwidthStore(db);
  assert.equal(store.getSettings().idlePollIntervalSeconds, 10);
  assert.equal(store.getSettings().activePollIntervalSeconds, 60);

  // The old column follows the idle interval, so an older image on this database still polls.
  store.saveSettings({ ...store.getSettings(), idlePollIntervalSeconds: 20 });
  const [[legacy]] = [
    ...db.query("SELECT poll_interval_seconds FROM bandwidth_automation_settings"),
  ];
  assert.equal(legacy, 20);
  db.close();
});

Deno.test("migration 12 never polls more often while capped than a longer old interval asked", () => {
  const db = createTestDb({ throughVersion: 11 });
  db.query("UPDATE bandwidth_automation_settings SET poll_interval_seconds = 120");
  migrateQuietly(db);

  const settings = new SqliteBandwidthStore(db).getSettings();
  assert.equal(settings.idlePollIntervalSeconds, 120);
  assert.equal(settings.activePollIntervalSeconds, 120);
  db.close();
});

Deno.test("settings and controller state round-trip through SQLite", () => {
  const db = createTestDb();
  const store = new SqliteBandwidthStore(db);

  const settings = {
    ...defaultBandwidthSettings,
    enabled: true,
    throttleBytesPerSecond: 4_000_000,
    throttleUnit: "MBps" as const,
    idlePollIntervalSeconds: 10,
    activePollIntervalSeconds: 120,
    recoveryGraceSeconds: 0,
    pausedPolicy: "idle" as const,
    pausedGraceSeconds: 0,
    updatedAt: "2026-11-09T20:00:00.000Z",
  };
  store.saveSettings(settings);
  assert.deepEqual(store.getSettings(), settings);

  const state = {
    mode: "throttled" as const,
    ownsLimit: true,
    priorLimitBytesPerSecond: 0,
    appliedLimitBytesPerSecond: CAP,
    restorePending: true,
    lastChange: {
      at: "2026-11-09T20:00:05.000Z",
      fromBytesPerSecond: 0,
      toBytesPerSecond: CAP,
      reason: "Jellyfin playback: cap applied",
    },
  };
  store.saveState(state);
  assert.deepEqual(store.getState(), state);
  db.close();
});

Deno.test("settings changes are validated strictly", () => {
  const ok = (input: unknown) => {
    const result = parseSettingsPatch(input);
    assert.ok(result.ok, `expected ${JSON.stringify(input)} to pass`);
    return result.patch;
  };
  const rejected = (input: unknown, pattern: RegExp) => {
    const result = parseSettingsPatch(input);
    assert.ok(!result.ok, `expected ${JSON.stringify(input)} to fail`);
    assert.match(result.error, pattern);
  };

  assert.deepEqual(ok({ enabled: true }), { enabled: true });
  assert.deepEqual(ok({ throttle: { value: 80, unit: "Mbps" } }), {
    throttle: { value: 80, unit: "Mbps" },
  });
  assert.deepEqual(ok({ throttle: { value: 12.5, unit: "MBps" } }), {
    throttle: { value: 12.5, unit: "MBps" },
  });
  assert.deepEqual(
    ok({
      idlePollIntervalSeconds: 2,
      activePollIntervalSeconds: 600,
      recoveryGraceSeconds: 0,
      pausedPolicy: "active",
      pausedGraceSeconds: 3600,
    }),
    {
      idlePollIntervalSeconds: 2,
      activePollIntervalSeconds: 600,
      recoveryGraceSeconds: 0,
      pausedPolicy: "active",
      pausedGraceSeconds: 3600,
    },
  );
  assert.deepEqual(ok({}), {});

  rejected(null, /JSON object/);
  rejected([], /JSON object/);
  rejected({ enabled: "yes" }, /enabled/);
  rejected({ sabnzbdApiKey: "x" }, /Unknown setting: sabnzbdApiKey/);
  rejected({ throttle: 80 }, /throttle/);
  rejected({ throttle: { value: 80, unit: "mbit" } }, /throttle/);
  rejected({ throttle: { value: "80", unit: "Mbps" } }, /throttle.value/);
  rejected({ throttle: { value: 0.5, unit: "Mbps" } }, /between 1 and 10000 Mb\/s/);
  rejected({ throttle: { value: 1251, unit: "MBps" } }, /between 1 and 10000 Mb\/s/);
  rejected({ throttle: { value: Number.NaN, unit: "Mbps" } }, /throttle/);
  rejected({ idlePollIntervalSeconds: 1 }, /idlePollIntervalSeconds/);
  rejected({ idlePollIntervalSeconds: 301 }, /idlePollIntervalSeconds/);
  rejected({ idlePollIntervalSeconds: 5.5 }, /idlePollIntervalSeconds/);
  rejected({ activePollIntervalSeconds: 601 }, /activePollIntervalSeconds/);
  rejected({ activePollIntervalSeconds: "60" }, /activePollIntervalSeconds/);
  rejected({ pollIntervalSeconds: 5 }, /Unknown setting: pollIntervalSeconds/);
  rejected({ recoveryGraceSeconds: -1 }, /recoveryGraceSeconds/);
  rejected({ pausedGraceSeconds: 3601 }, /pausedGraceSeconds/);
  rejected({ pausedPolicy: "sometimes" }, /pausedPolicy/);
});

Deno.test("the routes validate input and never return URLs or keys", async () => {
  const h = harness();
  await h.start();
  const routes = createBandwidthAutomationRoutes(h.controller);
  const patch = (body: string, contentType = "application/json") =>
    routes.request("/settings", {
      method: "PATCH",
      headers: { "content-type": contentType },
      body,
    });

  const status = await routes.request("/");
  assert.equal(status.status, 200);
  const text = await status.text();
  assert.ok(!text.includes(JELLYFIN_KEY) && !text.includes(SABNZBD_KEY));
  assert.ok(!/https?:\/\//.test(text), "no URLs in the status");
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.settings.enabled, false);
  assert.deepEqual(body.configured, { jellyfin: true, sabnzbd: true });

  assert.equal((await patch('{"enabled":true}', "text/plain")).status, 415);
  assert.equal((await patch("{nope")).status, 400);
  assert.equal((await patch('{"idlePollIntervalSeconds":0}')).status, 400);
  assert.equal((await patch(JSON.stringify({ padding: "x".repeat(20_000) }))).status, 413);

  const saved = await patch('{"throttle":{"value":10,"unit":"MBps"},"recoveryGraceSeconds":45}');
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.settings.throttleBytesPerSecond, CAP);
  assert.equal(savedBody.settings.throttleUnit, "MBps");
  assert.equal(savedBody.settings.recoveryGraceSeconds, 45);

  const reconcile = await routes.request("/reconcile", { method: "POST" });
  assert.equal(reconcile.status, 200);
  const reconcileBody = await reconcile.json();
  assert.equal(reconcileBody.outcome.checkOnly, true);
  await h.dispose();
});

Deno.test("turning automation on without configuration answers 409", async () => {
  const h = harness({ sabnzbd: null });
  await h.start();
  const routes = createBandwidthAutomationRoutes(h.controller);

  const response = await routes.request("/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: '{"enabled":true}',
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /SABNZBD_URL and SABNZBD_API_KEY/);
  await h.dispose();
});

function migrateQuietly(db: Parameters<typeof runMigrations>[0]): void {
  const log = console.log;
  console.log = () => {};
  try {
    runMigrations(db);
  } finally {
    console.log = log;
  }
}
