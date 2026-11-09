import assert from "node:assert/strict";
import { BandwidthConfigurationError } from "../../server/bandwidth/controller.ts";
import { staleSessionMs } from "../../server/bandwidth/policy.ts";
import {
  CAP,
  deferred,
  FakeClock,
  FakeJellyfin,
  FakeSabnzbd,
  harness,
  JELLYFIN_KEY,
  playing,
  SABNZBD_KEY,
} from "./helpers.ts";

const POLL = 5_000;
const GRACE = 30_000;
const PAUSED_GRACE = 120_000;

// ---------------------------------------------------------------------------------------------
// Stream counts

Deno.test("0 to 1 active stream caps SABnzbd once; later polls write nothing", async () => {
  const h = harness({ settings: { enabled: true } });
  h.sabnzbd.paused = true; // a paused queue must stay paused
  await h.start();

  assert.deepEqual(h.sabnzbd.writes, [], "idle and already unlimited: nothing to write");
  assert.equal(h.controller.getStatus().mode, "unrestricted");

  h.jellyfin.sessions = [playing()];
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);

  await h.advance(12 * POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP], "no redundant writes while the cap holds");
  assert.ok(h.jellyfin.calls >= 14);
  assert.equal(h.sabnzbd.paused, true, "the queue's pause is never touched");

  const status = h.controller.getStatus();
  assert.equal(status.mode, "throttled");
  assert.equal(status.decision.reason, "streams_active");
  assert.equal(status.playback?.countedStreams, 1);
  assert.equal(status.sabnzbd.speedLimitBytesPerSecond, CAP);
  assert.equal(status.lastChange?.toBytesPerSecond, CAP);
  assert.equal(status.lastChange?.fromBytesPerSecond, 0);
  assert.equal(status.ownership.priorLimitBytesPerSecond, 0);
  assert.ok(status.lastSuccessfulReconcileAt);
  await h.dispose();
});

Deno.test("1 to several streams, direct play and transcodes, keeps the cap without rewriting", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing()];
  await h.start();
  assert.deepEqual(h.sabnzbd.writes, [CAP]);

  h.jellyfin.sessions = [
    playing({ playMethod: "DirectPlay", userName: "remote-family" }),
    playing({ playMethod: "Transcode" }),
    playing({ playMethod: "DirectStream" }),
  ];
  await h.advance(POLL);

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  const playback = h.controller.getStatus().playback;
  assert.equal(playback?.countedStreams, 3);
  assert.equal(playback?.transcoding, 1);
  await h.dispose();
});

Deno.test("the final stream stopping lifts the cap after the recovery grace, not before", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing(), playing()];
  await h.start();

  h.jellyfin.sessions = [h.jellyfin.sessions[0]];
  await h.advance(POLL);
  assert.equal(h.controller.getStatus().playback?.countedStreams, 1);

  h.jellyfin.sessions = [];
  await h.advance(POLL); // first check that sees nothing playing: the grace starts here
  const status = h.controller.getStatus();
  assert.equal(status.decision.reason, "grace_period");
  assert.equal(status.decision.graceUntil, new Date(h.clock.now() + GRACE).toISOString());

  await h.advance(GRACE - 1);
  assert.deepEqual(h.sabnzbd.writes, [CAP], "still capped 1 ms before the grace ends");

  await h.advance(1);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0], "unlimited exactly when the grace ends");
  assert.equal(h.controller.getStatus().mode, "unrestricted");
  assert.equal(h.sabnzbd.limit, 0);
  await h.dispose();
});

Deno.test("a stream starting during the recovery grace keeps the cap with no extra writes", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing()];
  await h.start();

  h.jellyfin.sessions = [];
  await h.advance(POLL);
  await h.advance(20_000);
  h.jellyfin.sessions = [playing()];
  await h.advance(POLL);
  await h.advance(10 * 60_000);

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().decision.reason, "streams_active");
  await h.dispose();
});

Deno.test("sessions that are only connected never count", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.idleSessions = 4;
  await h.start();
  await h.advance(10 * POLL);

  assert.deepEqual(h.sabnzbd.writes, []);
  const playback = h.controller.getStatus().playback;
  assert.equal(playback?.totalSessions, 4);
  assert.equal(playback?.countedStreams, 0);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Paused and stale sessions

Deno.test("paused policy 'grace': a paused stream counts for the paused grace, then stops counting", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing({ isPaused: true, pausedAt: nowOf(h) })];
  await h.start();
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().playback?.pausedCounted, 1);

  await h.advance(PAUSED_GRACE - 1);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);

  await h.advance(1); // a check runs exactly when the paused grace ends; the recovery grace starts
  assert.equal(h.controller.getStatus().playback?.pausedIgnored, 1);
  assert.equal(h.controller.getStatus().decision.reason, "grace_period");

  await h.advance(GRACE);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  await h.dispose();
});

Deno.test("paused policy 'grace' without LastPausedDate times the pause from when it was first seen", async () => {
  const h = harness({ settings: { enabled: true, pausedGraceSeconds: 60 } });
  const session = playing();
  h.jellyfin.sessions = [session];
  await h.start();

  await h.advance(10_000);
  h.jellyfin.sessions = [{ ...session, isPaused: true }]; // older Jellyfin: no pausedAt
  await h.advance(POLL); // first seen paused here

  await h.advance(60_000 - 1);
  assert.equal(h.controller.getStatus().playback?.pausedCounted, 1);
  await h.advance(1);
  assert.equal(h.controller.getStatus().playback?.pausedIgnored, 1);

  // Resuming counts again right away.
  h.jellyfin.sessions = [{ ...session, isPaused: false }];
  await h.advance(POLL);
  assert.equal(h.controller.getStatus().playback?.countedStreams, 1);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  await h.dispose();
});

Deno.test("paused policy 'active' keeps the cap for as long as a stream is paused", async () => {
  const h = harness({ settings: { enabled: true, pausedPolicy: "active" } });
  h.jellyfin.sessions = [playing({ isPaused: true, pausedAt: nowOf(h) - 3_600_000 })];
  await h.start();
  await h.advance(60 * 60_000);

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().playback?.pausedCounted, 1);
  await h.dispose();
});

Deno.test("paused policy 'idle' never counts a paused stream", async () => {
  const h = harness({ settings: { enabled: true, pausedPolicy: "idle" } });
  h.jellyfin.sessions = [playing({ isPaused: true, pausedAt: nowOf(h) })];
  await h.start();
  await h.advance(5 * 60_000);

  assert.deepEqual(h.sabnzbd.writes, []);
  assert.equal(h.controller.getStatus().playback?.pausedIgnored, 1);
  await h.dispose();
});

Deno.test("stale sessions stop counting once Jellyfin hasn't heard from them for 5 minutes", async () => {
  const h = harness({ settings: { enabled: true } });
  // Long gone: never counts.
  h.jellyfin.sessions = [playing({ lastSeenAt: nowOf(h) - staleSessionMs - 1 })];
  await h.start();
  assert.deepEqual(h.sabnzbd.writes, []);
  assert.equal(h.controller.getStatus().playback?.stale, 1);

  // Fresh now, then the client vanishes: it counts until it goes stale.
  const vanishing = playing({ lastSeenAt: h.clock.now() });
  h.jellyfin.sessions = [vanishing];
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);

  await h.advance(staleSessionMs - POLL - 1);
  assert.equal(h.controller.getStatus().playback?.countedStreams, 1);
  await h.advance(1);
  assert.equal(h.controller.getStatus().playback?.stale, 1);

  await h.advance(GRACE);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Webhooks

Deno.test("a PlaybackStart webhook reconciles at once, without waiting for the poll", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);

  h.jellyfin.sessions = [playing()];
  h.controller.handleJellyfinWebhook({ NotificationType: "PlaybackStart" });
  await h.settle();

  assert.deepEqual(h.sabnzbd.writes, [CAP], "capped 2 s after startup, 3 s before the next poll");
  assert.match(h.controller.getStatus().lastReconcile?.trigger ?? "", /webhook:PlaybackStart/);
  await h.dispose();
});

Deno.test("repeated webhooks for the same playback write SABnzbd once", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);
  const callsBefore = h.jellyfin.calls;

  h.jellyfin.sessions = [playing()];
  for (let i = 0; i < 5; i++) {
    h.controller.handleJellyfinWebhook({ NotificationType: "PlaybackStart" });
  }
  await h.settle();
  await h.advance(1_000);

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.jellyfin.calls - callsBefore, 1, "the burst collapsed into one reconcile");
  await h.dispose();
});

Deno.test("progress pings only trigger a reconcile for a new stream or a pause change", async () => {
  const h = harness({ settings: { enabled: true, pausedPolicy: "idle" } });
  const session = playing({ deviceId: "tv" });
  h.jellyfin.sessions = [session];
  await h.start();
  await h.advance(2_000);
  const callsBefore = h.jellyfin.calls;

  for (let i = 0; i < 10; i++) {
    h.controller.handleJellyfinWebhook({
      NotificationType: "PlaybackProgress",
      DeviceId: "tv",
      IsPaused: false,
    });
  }
  await h.settle();
  assert.equal(h.jellyfin.calls, callsBefore, "plain progress pings are ignored");

  h.jellyfin.sessions = [{ ...session, isPaused: true }];
  h.controller.handleJellyfinWebhook({
    NotificationType: "PlaybackProgress",
    DeviceId: "tv",
    IsPaused: true,
  });
  await h.settle();
  assert.equal(h.jellyfin.calls, callsBefore + 1, "a pause is a state change");
  assert.equal(h.controller.getStatus().decision.reason, "grace_period");
  await h.dispose();
});

Deno.test("webhook-triggered reconciles are at least a second apart", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);
  const callsBefore = h.jellyfin.calls;

  h.controller.handleJellyfinWebhook({ NotificationType: "PlaybackStart" });
  await h.settle();
  h.controller.handleJellyfinWebhook({ NotificationType: "PlaybackStop" });
  h.controller.handleJellyfinWebhook({ NotificationType: "PlaybackStart" });
  await h.settle();
  assert.equal(h.jellyfin.calls - callsBefore, 1, "the second burst waits");

  await h.advance(999);
  assert.equal(h.jellyfin.calls - callsBefore, 1);
  await h.advance(1);
  assert.equal(h.jellyfin.calls - callsBefore, 2, "and runs once, a second after the first");
  await h.dispose();
});

Deno.test("a missed PlaybackStart or PlaybackStop is caught by polling", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();

  h.jellyfin.sessions = [playing()]; // no webhook
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);

  h.jellyfin.sessions = []; // no webhook either
  await h.advance(POLL + GRACE);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  await h.dispose();
});

Deno.test("webhooks and polling do nothing while automation is off", async () => {
  const h = harness();
  await h.start();
  h.jellyfin.sessions = [playing()];
  h.controller.handleJellyfinWebhook({ NotificationType: "PlaybackStart" });
  await h.advance(10 * 60_000);

  assert.equal(h.jellyfin.calls, 0);
  assert.equal(h.sabnzbd.reads, 0);
  assert.deepEqual(h.sabnzbd.writes, []);
  assert.equal(h.clock.pendingTimers, 0);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Jellyfin failures

Deno.test("an unreachable Jellyfin applies the protective cap and keeps it without rewriting", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  assert.deepEqual(h.sabnzbd.writes, []);

  h.jellyfin.failWith = new Error("Jellyfin refused the connection");
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  let status = h.controller.getStatus();
  assert.equal(status.decision.reason, "jellyfin_unavailable");
  assert.equal(status.jellyfin.state, "error");
  assert.equal(status.jellyfin.lastError, "Jellyfin refused the connection");

  await h.advance(10 * POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  status = h.controller.getStatus();
  assert.equal(status.recentErrors.length, 1, "repeats of one error are counted, not listed");
  assert.equal(status.recentErrors[0].count, 11);

  // Back, with nothing playing: the cap comes off after the recovery grace.
  h.jellyfin.failWith = null;
  await h.advance(POLL);
  assert.equal(h.controller.getStatus().jellyfin.state, "ok");
  assert.equal(h.controller.getStatus().decision.reason, "grace_period");
  await h.advance(GRACE);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  await h.dispose();
});

Deno.test("Jellyfin failing during playback keeps the cap on", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing()];
  await h.start();

  h.jellyfin.sessions = [];
  h.jellyfin.failWith = new Error("Jellyfin did not answer within 3s");
  await h.advance(10 * 60_000);

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().mode, "throttled");
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// SABnzbd failures

Deno.test("an unreachable SABnzbd is retried at the next poll and caught up when it's back", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  const lastSuccess = h.controller.getStatus().lastSuccessfulReconcileAt;

  h.sabnzbd.readFailure = new Error("SABnzbd refused the connection");
  h.jellyfin.sessions = [playing()];
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, []);
  let status = h.controller.getStatus();
  assert.equal(status.sabnzbd.state, "error");
  assert.equal(status.mode, "throttled", "the decision stands even though it couldn't be applied");
  assert.equal(status.lastReconcile?.success, false);
  assert.equal(status.lastSuccessfulReconcileAt, lastSuccess);

  h.sabnzbd.readFailure = null;
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  status = h.controller.getStatus();
  assert.equal(status.sabnzbd.state, "ok");
  assert.equal(status.lastReconcile?.success, true);
  await h.dispose();
});

Deno.test("a failed speed-limit write is retried at the next poll", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();

  h.sabnzbd.writeFailure = new Error("SABnzbd answered HTTP 500");
  h.jellyfin.sessions = [playing()];
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, []);
  assert.equal(h.controller.getStatus().sabnzbd.lastError, "SABnzbd answered HTTP 500");
  assert.equal(h.controller.getStatus().ownership.priorLimitBytesPerSecond, 0);

  h.sabnzbd.writeFailure = null;
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().ownership.appliedLimitBytesPerSecond, CAP);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Restarts

Deno.test("after a restart with a stream still playing, startup checks and writes nothing", async () => {
  const sabnzbd = new FakeSabnzbd();
  const jellyfin = new FakeJellyfin();
  jellyfin.sessions = [playing()];
  const first = harness({ settings: { enabled: true }, jellyfin, sabnzbd });
  await first.start();
  assert.deepEqual(sabnzbd.writes, [CAP]);
  await first.dispose({ keepDb: true });

  const second = harness({
    db: first.db,
    jellyfin,
    sabnzbd,
    clock: new FakeClock(nowOf(first) + 60_000),
  });
  await second.start();
  assert.deepEqual(sabnzbd.writes, [CAP]);
  const status = second.controller.getStatus();
  assert.equal(status.settings.enabled, true);
  assert.equal(status.mode, "throttled");
  assert.equal(status.lastReconcile?.trigger, "startup");
  await second.dispose();
});

Deno.test("after a restart with playback over, the cap comes off one grace period after startup", async () => {
  const sabnzbd = new FakeSabnzbd();
  const jellyfin = new FakeJellyfin();
  jellyfin.sessions = [playing()];
  const first = harness({ settings: { enabled: true }, jellyfin, sabnzbd });
  await first.start();
  await first.dispose({ keepDb: true });

  jellyfin.sessions = [];
  const second = harness({
    db: first.db,
    jellyfin,
    sabnzbd,
    clock: new FakeClock(nowOf(first) + 600_000),
  });
  await second.start();
  assert.equal(second.controller.getStatus().decision.reason, "grace_period");
  await second.advance(GRACE - 1);
  assert.deepEqual(sabnzbd.writes, [CAP]);
  await second.advance(1);
  assert.deepEqual(sabnzbd.writes, [CAP, 0]);
  await second.dispose();
});

Deno.test("a SABnzbd restart that dropped the cap during downtime is corrected at startup", async () => {
  const sabnzbd = new FakeSabnzbd();
  const jellyfin = new FakeJellyfin();
  jellyfin.sessions = [playing()];
  const first = harness({ settings: { enabled: true }, jellyfin, sabnzbd });
  await first.start();
  await first.dispose({ keepDb: true });

  sabnzbd.limit = 0; // SABnzbd restarted and forgot the limit set over its API
  const second = harness({ db: first.db, jellyfin, sabnzbd });
  await second.start();
  assert.deepEqual(sabnzbd.writes, [CAP, CAP]);
  await second.dispose();
});

Deno.test("a restore still owed when the app stopped is finished at the next startup", async () => {
  const sabnzbd = new FakeSabnzbd();
  const jellyfin = new FakeJellyfin();
  jellyfin.sessions = [playing()];
  const first = harness({ settings: { enabled: true }, jellyfin, sabnzbd });
  await first.start();
  sabnzbd.readFailure = new Error("SABnzbd refused the connection");
  await first.controller.updateSettings({ enabled: false });
  assert.equal(first.controller.getStatus().ownership.restorePending, true);
  await first.dispose({ keepDb: true });

  sabnzbd.readFailure = null;
  const second = harness({ db: first.db, jellyfin, sabnzbd });
  await second.start();
  assert.deepEqual(sabnzbd.writes, [CAP, 0]);
  const status = second.controller.getStatus();
  assert.equal(status.ownership.restorePending, false);
  assert.equal(status.ownership.ownsLimit, false);
  assert.equal(second.clock.pendingTimers, 0);
  await second.dispose();
});

// ---------------------------------------------------------------------------------------------
// Concurrency

Deno.test("overlapping triggers never run at once and collapse into one follow-up", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);
  const callsBefore = h.jellyfin.calls;
  const gate = deferred();
  h.jellyfin.gate = gate;
  h.jellyfin.sessions = [playing()];

  const running = h.controller.requestReconcile("poll");
  await until(() => h.jellyfin.active === 1); // started, and blocked on the gate
  const queued = Array.from({ length: 10 }, () => h.controller.reconcileNow()); // one queued run
  const outcomes = [running, ...queued];
  gate.resolve();
  h.jellyfin.gate = null;
  await Promise.all(outcomes);
  await h.settle();

  assert.equal(h.jellyfin.maxActive, 1);
  assert.equal(h.sabnzbd.maxActive, 1);
  assert.equal(h.jellyfin.calls - callsBefore, 2);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  await h.dispose();
});

Deno.test("a settings change waits for a reconcile in progress", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing()];
  await h.start();
  const gate = deferred();
  h.sabnzbd.gate = gate;

  const reconcile = h.controller.requestReconcile("poll");
  await until(() => h.sabnzbd.active === 1); // blocked inside SABnzbd
  const jellyfinCalls = h.jellyfin.calls;
  const update = h.controller.updateSettings({ throttle: { value: 40, unit: "Mbps" } });
  for (let tick = 0; tick < 50; tick++) {
    await Promise.resolve();
  }
  assert.equal(h.store.getSettings().throttleBytesPerSecond, CAP, "the change hasn't started");
  assert.equal(h.jellyfin.calls, jellyfinCalls);

  gate.resolve();
  h.sabnzbd.gate = null;
  await Promise.all([reconcile, update]);

  assert.equal(h.sabnzbd.maxActive, 1);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 5_000_000]);
  assert.equal(h.store.getSettings().throttleBytesPerSecond, 5_000_000);
  await h.dispose();
});

Deno.test("starting twice runs one startup reconcile and keeps one poll timer", async () => {
  const h = harness({ settings: { enabled: true } });
  h.controller.start();
  h.controller.start();
  await h.settle();

  assert.equal(h.jellyfin.calls, 1);
  assert.equal(h.clock.pendingTimers, 1);
  await h.advance(POLL);
  assert.equal(h.jellyfin.calls, 2);
  assert.equal(h.clock.pendingTimers, 1);
  await h.dispose();
});

Deno.test("stopping clears every timer and later requests are skipped", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.controller.stop();

  assert.equal(h.clock.pendingTimers, 0);
  const outcome = await h.controller.reconcileNow();
  assert.equal(outcome.skipped, "stopped");
  assert.equal(h.jellyfin.calls, 1);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Changes made in SABnzbd by hand

Deno.test("a limit changed by hand while capped is set back once and reported", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing()];
  await h.start();

  h.sabnzbd.limit = 20_000_000;
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP, CAP]);
  const status = h.controller.getStatus();
  assert.match(status.notice?.message ?? "", /changed outside ObservaRR/);
  assert.equal(status.conflict.externalChanges, 1);
  assert.equal(status.conflict.suspected, false);
  assert.match(status.lastChange?.reason ?? "", /changed outside ObservaRR/);

  await h.advance(10 * POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP, CAP]);
  await h.dispose();
});

Deno.test("outside changes that keep coming back are flagged as a conflicting controller", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing()];
  await h.start();

  for (let i = 0; i < 3; i++) {
    h.sabnzbd.limit = 50_000_000;
    await h.advance(POLL);
  }

  const status = h.controller.getStatus();
  assert.equal(status.conflict.suspected, true);
  assert.equal(status.conflict.externalChanges, 3);
  assert.ok(h.logs.some((entry) => entry.event === "bandwidth.conflict_suspected"));
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Turning automation off

Deno.test("turning automation off puts back the limit SABnzbd had before", async () => {
  const h = harness({ settings: { enabled: true } });
  h.sabnzbd.limit = 25_000_000; // the owner's own limit: 200 Mb/s
  h.jellyfin.sessions = [playing()];
  await h.start();
  assert.deepEqual(h.sabnzbd.writes, [CAP]);

  const status = await h.controller.updateSettings({ enabled: false });
  assert.deepEqual(h.sabnzbd.writes, [CAP, 25_000_000]);
  assert.equal(status.ownership.ownsLimit, false);
  assert.equal(status.ownership.restorePending, false);
  assert.match(status.notice?.message ?? "", /back to 200 Mb\/s \(25 MB\/s\)/);
  assert.equal(h.clock.pendingTimers, 0, "no polling once off");

  await h.advance(10 * 60_000);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 25_000_000]);
  await h.dispose();
});

Deno.test("turning automation off leaves a limit someone changed by hand alone", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing()];
  await h.start();

  h.sabnzbd.limit = 5_000_000; // set by hand before the next poll could notice
  const status = await h.controller.updateSettings({ enabled: false });

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.sabnzbd.limit, 5_000_000);
  assert.match(status.notice?.message ?? "", /changed outside ObservaRR/);
  assert.equal(status.ownership.ownsLimit, false);
  await h.dispose();
});

Deno.test("turning off while SABnzbd is unreachable retries the restore until it works", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing()];
  await h.start();

  h.sabnzbd.readFailure = new Error("SABnzbd refused the connection");
  let status = await h.controller.updateSettings({ enabled: false });
  assert.equal(status.ownership.restorePending, true);
  assert.match(status.notice?.message ?? "", /retrying every 30 seconds/);

  await h.advance(30_000);
  assert.equal(h.controller.getStatus().ownership.restorePending, true);
  assert.equal(h.jellyfin.calls, 1, "no Jellyfin polling while off");

  h.sabnzbd.readFailure = null;
  await h.advance(30_000);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  status = h.controller.getStatus();
  assert.equal(status.ownership.restorePending, false);
  assert.equal(h.clock.pendingTimers, 0);
  await h.dispose();
});

Deno.test("turning it back on before a restore happened keeps the original prior limit", async () => {
  const h = harness({ settings: { enabled: true } });
  h.sabnzbd.limit = 25_000_000;
  h.jellyfin.sessions = [playing()];
  await h.start();

  h.sabnzbd.readFailure = new Error("SABnzbd refused the connection");
  await h.controller.updateSettings({ enabled: false });
  h.sabnzbd.readFailure = null;
  await h.controller.updateSettings({ enabled: true });
  assert.deepEqual(h.sabnzbd.writes, [CAP], "still capped: the stream is still playing");
  assert.equal(h.controller.getStatus().ownership.priorLimitBytesPerSecond, 25_000_000);

  await h.controller.updateSettings({ enabled: false });
  assert.deepEqual(h.sabnzbd.writes, [CAP, 25_000_000]);
  await h.dispose();
});

Deno.test("a limit set by hand while automation is on and idle is undone, then restored on turning off", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();

  h.sabnzbd.limit = 20_000_000;
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, [0], "no playback: unlimited");
  assert.equal(h.controller.getStatus().ownership.priorLimitBytesPerSecond, 20_000_000);

  await h.controller.updateSettings({ enabled: false });
  assert.deepEqual(h.sabnzbd.writes, [0, 20_000_000]);
  await h.dispose();
});

Deno.test("turning off when automation never changed SABnzbd writes nothing", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.controller.updateSettings({ enabled: false });

  assert.deepEqual(h.sabnzbd.writes, []);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Settings and manual reconciles

Deno.test("Reconcile now with automation off only looks", async () => {
  const h = harness();
  h.jellyfin.sessions = [playing()];
  await h.start();

  const outcome = await h.controller.reconcileNow();
  assert.equal(outcome.checkOnly, true);
  assert.equal(outcome.countedStreams, 1);
  assert.deepEqual(h.sabnzbd.writes, []);
  const status = h.controller.getStatus();
  assert.equal(status.jellyfin.state, "ok");
  assert.equal(status.sabnzbd.state, "ok");
  assert.equal(status.lastSuccessfulReconcileAt, null);
  assert.equal(h.clock.pendingTimers, 0);
  await h.dispose();
});

Deno.test("automation can't be turned on without Jellyfin and SABnzbd configured", async () => {
  const h = harness({ jellyfin: null });
  await h.start();

  await assert.rejects(
    () => h.controller.updateSettings({ enabled: true }),
    (error: unknown) =>
      error instanceof BandwidthConfigurationError && /JELLYFIN_URL/.test(error.message),
  );
  assert.equal(h.controller.getStatus().settings.enabled, false);
  assert.equal(h.store.getSettings().enabled, false);
  assert.equal(h.controller.getStatus().jellyfin.state, "not_configured");
  await h.dispose();
});

Deno.test("turning automation on reconciles at once, and a new cap is written at once", async () => {
  const h = harness();
  h.jellyfin.sessions = [playing()];
  await h.start();

  await h.controller.updateSettings({ enabled: true });
  assert.deepEqual(h.sabnzbd.writes, [CAP]);

  const status = await h.controller.updateSettings({ throttle: { value: 4, unit: "MBps" } });
  assert.deepEqual(h.sabnzbd.writes, [CAP, 4_000_000]);
  assert.equal(status.settings.throttleUnit, "MBps");
  assert.equal(status.settings.throttleValue, 4);
  assert.equal(h.store.getSettings().throttleBytesPerSecond, 4_000_000);
  await h.dispose();
});

Deno.test("a new poll interval takes effect right away", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();

  await h.controller.updateSettings({ pollIntervalSeconds: 30 });
  const callsBefore = h.jellyfin.calls;
  await h.advance(29_999);
  assert.equal(h.jellyfin.calls, callsBefore);
  await h.advance(1);
  assert.equal(h.jellyfin.calls, callsBefore + 1);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Secrets

Deno.test("API keys never reach the status, the error list or the logs", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();

  h.jellyfin.failWith = new Error(
    `error sending request for url (http://jellyfin:8096/Sessions?api_key=${JELLYFIN_KEY})`,
  );
  h.sabnzbd.writeFailure = new Error(`request to http://sab:8080/api?apikey=${SABNZBD_KEY} failed`);
  await h.advance(POLL);

  const status = JSON.stringify(h.controller.getStatus());
  const logs = JSON.stringify(h.logs);
  for (const text of [status, logs]) {
    assert.ok(!text.includes(JELLYFIN_KEY));
    assert.ok(!text.includes(SABNZBD_KEY));
  }
  assert.match(status, /\[redacted\]/);
  await h.dispose();
});

function nowOf(h: { clock: FakeClock }): number {
  return h.clock.now();
}

/** Lets queued microtasks run until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let tick = 0; tick < 100 && !condition(); tick++) {
    await Promise.resolve();
  }
  assert.ok(condition(), "condition never held");
}
