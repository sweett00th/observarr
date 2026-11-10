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
  playbackEvent,
  playing,
  SABNZBD_KEY,
} from "./helpers.ts";

/** The interval the polling-driven scenarios below run with. */
const POLL = 5_000;
const POLL_5S = { idlePollIntervalSeconds: 5, activePollIntervalSeconds: 5 };
/** The default intervals: while nothing plays, and while capped. */
const IDLE = 15_000;
const ACTIVE = 60_000;
const GRACE = 30_000;
const PAUSED_GRACE = 120_000;

// ---------------------------------------------------------------------------------------------
// Stream counts

Deno.test("0 to 1 active stream caps SABnzbd once; later polls write nothing", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  assert.equal(status.controllerMode, "throttled");
  assert.equal(status.decision.reason, "streams_active");
  assert.equal(status.playback?.countedStreams, 1);
  assert.equal(status.sabnzbd.speedLimitBytesPerSecond, CAP);
  assert.equal(status.lastChange?.toBytesPerSecond, CAP);
  assert.equal(status.lastChange?.fromBytesPerSecond, 0);
  assert.equal(status.ownership.priorLimitBytesPerSecond, 0);
  assert.ok(status.lastSuccessfulReconcileAt);
  assert.equal(status.lastTrigger?.source, "poll");
  await h.dispose();
});

Deno.test("1 to several streams, direct play and transcodes, keeps the cap without rewriting", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
  h.jellyfin.sessions = [playing(), playing()];
  await h.start();

  h.jellyfin.sessions = [h.jellyfin.sessions[0]];
  await h.advance(POLL);
  assert.equal(h.controller.getStatus().playback?.countedStreams, 1);

  h.jellyfin.sessions = [];
  await h.advance(POLL); // first check that sees nothing playing: the grace starts here
  const status = h.controller.getStatus();
  assert.equal(status.decision.reason, "grace_period");
  assert.equal(status.controllerMode, "recovery_grace");
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, pausedGraceSeconds: 60, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, pausedPolicy: "active", ...POLL_5S } });
  h.jellyfin.sessions = [playing({ isPaused: true, pausedAt: nowOf(h) - 3_600_000 })];
  await h.start();
  await h.advance(60 * 60_000);

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().playback?.pausedCounted, 1);
  await h.dispose();
});

Deno.test("paused policy 'idle' never counts a paused stream", async () => {
  const h = harness({ settings: { enabled: true, pausedPolicy: "idle", ...POLL_5S } });
  h.jellyfin.sessions = [playing({ isPaused: true, pausedAt: nowOf(h) })];
  await h.start();
  await h.advance(5 * 60_000);

  assert.deepEqual(h.sabnzbd.writes, []);
  assert.equal(h.controller.getStatus().playback?.pausedIgnored, 1);
  await h.dispose();
});

Deno.test("stale sessions stop counting once Jellyfin hasn't heard from them for 5 minutes", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
// The fast path: playback starts and resumes

Deno.test("1. PlaybackStart caps SABnzbd at once, before any Jellyfin request or SABnzbd read", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);
  const before = h.calls.length;

  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.deepEqual(
    h.calls.slice(before),
    [`sab:write:${CAP}`, "jellyfin:sessions", "sab:read"],
    "the cap is the first request; the check of Jellyfin's sessions comes after",
  );

  const status = h.controller.getStatus();
  assert.equal(status.controllerMode, "throttled");
  assert.equal(status.decision.reason, "streams_active", "the follow-up check confirmed it");
  assert.equal(status.lastWebhook?.event, "PlaybackStart");
  assert.equal(status.lastWebhook?.outcome, "capped");
  assert.equal(status.lastTrigger?.source, "webhook");
  assert.match(status.lastChange?.reason ?? "", /playback started \(webhook\)/);
  assert.equal(status.ownership.priorLimitBytesPerSecond, 0, "taken from the last SABnzbd read");
  assert.equal(status.settings.throttleBytesPerSecond, CAP, "the saved cap is unchanged");
  await h.dispose();
});

Deno.test("2. a resume (PlaybackProgress turning IsPaused off) caps SABnzbd at once", async () => {
  const h = harness({ settings: { enabled: true, pausedPolicy: "idle" } });
  h.jellyfin.sessions = [playing({ deviceId: "tv", isPaused: true })];
  await h.start();
  assert.deepEqual(h.sabnzbd.writes, [], "a paused stream doesn't count under 'idle'");
  await h.advance(2_000);
  const before = h.calls.length;

  h.jellyfin.sessions = [playing({ deviceId: "tv", isPaused: false })];
  h.webhook(playbackEvent("PlaybackProgress", { IsPaused: false }));
  await h.settle();

  assert.equal(h.calls[before], `sab:write:${CAP}`);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().lastWebhook?.event, "PlaybackProgress (resumed)");
  await h.dispose();
});

Deno.test("3. duplicate PlaybackStart events write SABnzbd once", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);
  const jellyfinCalls = h.jellyfin.calls;

  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  for (let i = 0; i < 5; i++) {
    h.webhook(playbackEvent("PlaybackStart"));
  }
  await h.settle();
  await h.advance(1_000);

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.sabnzbd.maxActive, 1, "never two SABnzbd requests at once");
  assert.ok(h.jellyfin.calls - jellyfinCalls <= 2, "the burst's checks were shared");

  // A resent start later, while capped, writes nothing either.
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().lastWebhook?.outcome, "already_capped");
  await h.dispose();
});

Deno.test("4. PlaybackProgress pings that change nothing cost no requests and no log lines", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  await h.start();
  await h.advance(2_000);
  const calls = h.calls.length;
  const logLines = h.logs.length;

  for (let i = 0; i < 20; i++) {
    h.webhook(playbackEvent("PlaybackProgress", { PlaybackPositionTicks: i * 100_000_000 }));
  }
  await h.settle();

  assert.equal(h.calls.length, calls);
  assert.equal(h.logs.length, logLines);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  await h.dispose();
});

Deno.test("concurrent starts from several users cap once, and every stream counts", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);

  h.jellyfin.sessions = [playing({ deviceId: "tv" })]; // the phone isn't listed yet
  h.webhook(playbackEvent("PlaybackStart"));
  h.webhook(playbackEvent("PlaybackStart", { DeviceId: "phone", UserId: "remote" }));
  await h.settle();

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  let playback = h.controller.getStatus().playback;
  assert.equal(playback?.countedStreams, 1);
  assert.equal(playback?.pendingWebhookStreams, 1, "the phone counts until Jellyfin lists it");

  // The TV stops. The phone's start still counts while Jellyfin catches up: no grace yet.
  h.jellyfin.sessions = [];
  await h.advance(1_000);
  h.webhook(playbackEvent("PlaybackStop"));
  await h.settle();
  assert.equal(h.controller.getStatus().decision.reason, "streams_active");

  // Jellyfin never lists the phone: once its start is a minute old (at 62 s) it stops counting.
  await h.advance(59_000);
  playback = h.controller.getStatus().playback;
  assert.equal(playback?.pendingWebhookStreams, 0);
  assert.equal(h.controller.getStatus().decision.reason, "grace_period");
  await h.advance(GRACE);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  await h.dispose();
});

Deno.test("the fast path reports webhook-to-SABnzbd timings on the monotonic clock", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);
  h.sabnzbd.onWrite = () => h.clock.bump(40); // SABnzbd takes 40 ms to acknowledge

  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();

  const timing = h.controller.getStatus().lastWebhookThrottle;
  assert.equal(timing?.outcome, "capped");
  assert.equal(timing?.event, "PlaybackStart");
  assert.equal(timing?.receivedToRequestMs, 0, "nothing was asked before the write");
  assert.equal(timing?.requestMs, 40);
  assert.equal(timing?.receivedToAckMs, 40);
  assert.equal(timing?.receivedToReconcileMs, 40, "the follow-up check finished right after");

  const logged = h.logs.find((entry) => entry.event === "bandwidth.webhook");
  assert.equal(logged?.details.notification, "PlaybackStart");
  assert.equal(logged?.details.outcome, "capped");
  assert.equal(logged?.details.receivedToAckMs, 40);

  // A duplicate start doesn't overwrite the timing of the write that happened.
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();
  assert.equal(h.controller.getStatus().lastWebhookThrottle?.receivedToAckMs, 40);
  await h.dispose();
});

Deno.test("before SABnzbd has ever answered, the fast path reads it once so the right limit can go back", async () => {
  const h = harness({ settings: { enabled: true } });
  h.sabnzbd.readFailure = new Error("SABnzbd refused the connection");
  await h.start(); // SABnzbd unreadable: nothing known about its limit
  h.sabnzbd.readFailure = null;
  h.sabnzbd.limit = 25_000_000; // the owner's own limit

  await h.advance(2_000);
  const before = h.calls.length;
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();

  assert.deepEqual(h.calls.slice(before, before + 2), ["sab:read", `sab:write:${CAP}`]);
  assert.equal(h.controller.getStatus().ownership.priorLimitBytesPerSecond, 25_000_000);

  await h.controller.updateSettings({ enabled: false });
  assert.deepEqual(h.sabnzbd.writes, [CAP, 25_000_000]);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// The conservative path: stops and pauses

Deno.test("5. PlaybackStop doesn't lift the cap at once", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  await h.start();
  await h.advance(2_000);

  h.jellyfin.sessions = [];
  h.webhook(playbackEvent("PlaybackStop"));
  await h.settle();

  assert.deepEqual(h.sabnzbd.writes, [CAP], "still capped");
  const status = h.controller.getStatus();
  assert.equal(status.controllerMode, "recovery_grace");
  assert.equal(status.decision.reason, "grace_period");
  assert.equal(status.lastWebhook?.outcome, "check_requested");
  await h.dispose();
});

Deno.test("6. PlaybackStop while another user still plays keeps the cap", async () => {
  const h = harness({ settings: { enabled: true } });
  const remote = playing({ deviceId: "phone", userName: "remote-family" });
  h.jellyfin.sessions = [playing({ deviceId: "tv" }), remote];
  await h.start();
  await h.advance(2_000);

  h.jellyfin.sessions = [remote];
  h.webhook(playbackEvent("PlaybackStop", { DeviceId: "tv" }));
  await h.settle();

  const status = h.controller.getStatus();
  assert.equal(status.decision.reason, "streams_active");
  assert.equal(status.decision.graceUntil, null);
  await h.advance(10 * 60_000);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  await h.dispose();
});

Deno.test("7. the last stream stopping: grace period, Jellyfin checked again, then the cap comes off", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  await h.start();
  await h.advance(2_000);

  h.jellyfin.sessions = [];
  h.webhook(playbackEvent("PlaybackStop"));
  await h.settle();
  const callsAtStop = h.jellyfin.calls;

  await h.advance(GRACE - 1);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.jellyfin.calls, callsAtStop, "no polling in between: the active interval is 60 s");

  await h.advance(1);
  assert.equal(h.jellyfin.calls, callsAtStop + 1, "Jellyfin was asked again before lifting it");
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  assert.equal(h.controller.getStatus().controllerMode, "unrestricted");
  await h.dispose();
});

Deno.test("8. a start during the recovery grace cancels the pending unthrottle", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  await h.start();
  await h.advance(2_000);

  h.jellyfin.sessions = [];
  h.webhook(playbackEvent("PlaybackStop"));
  await h.settle();
  assert.equal(h.controller.getStatus().controllerMode, "recovery_grace");

  await h.advance(20_000);
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();

  let status = h.controller.getStatus();
  assert.equal(status.decision.graceUntil, null);
  assert.equal(status.controllerMode, "throttled");
  assert.equal(status.lastWebhook?.outcome, "already_capped");

  await h.advance(GRACE); // past when the grace would have ended
  await h.advance(10 * 60_000);
  status = h.controller.getStatus();
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(status.decision.reason, "streams_active");
  await h.dispose();
});

Deno.test("a pause is checked with Jellyfin, and the paused-streams policy decides", async () => {
  const h = harness({ settings: { enabled: true, pausedPolicy: "idle" } });
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  await h.start();
  await h.advance(2_000);
  const callsBefore = h.jellyfin.calls;

  h.jellyfin.sessions = [playing({ deviceId: "tv", isPaused: true })];
  h.webhook(playbackEvent("PlaybackProgress", { IsPaused: true }));
  await h.settle();

  assert.equal(h.jellyfin.calls, callsBefore + 1);
  assert.equal(h.controller.getStatus().lastWebhook?.event, "PlaybackProgress (paused)");
  assert.equal(h.controller.getStatus().decision.reason, "grace_period");
  assert.deepEqual(h.sabnzbd.writes, [CAP], "a pause never lifts the cap by itself");
  await h.dispose();
});

Deno.test("an out-of-order stop for a stream that is still playing never lifts the cap", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  await h.start();
  await h.advance(2_000);

  // A stop from an earlier session on the same TV arrives late, after the new start.
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();
  h.webhook(playbackEvent("PlaybackStop", { Id: "an-older-session" }));
  await h.settle();
  await h.advance(1_000);

  assert.equal(h.controller.getStatus().decision.reason, "streams_active");
  await h.advance(10 * 60_000);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  await h.dispose();
});

Deno.test("webhook-triggered checks are at least a second apart", async () => {
  const h = harness({ settings: { enabled: true }, webhookAuth: false });
  await h.start();
  await h.advance(2_000);
  const callsBefore = h.jellyfin.calls;

  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();
  h.webhook(playbackEvent("PlaybackStop"));
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();
  assert.equal(h.jellyfin.calls - callsBefore, 1, "the second burst waits");

  await h.advance(999);
  assert.equal(h.jellyfin.calls - callsBefore, 1);
  await h.advance(1);
  assert.equal(h.jellyfin.calls - callsBefore, 2, "and runs once, a second after the first");
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Races

Deno.test("9. race: a delayed empty answer from before a newer start can't lift the cap", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  await h.start();
  await h.advance(2_000);

  h.jellyfin.sessions = [];
  h.webhook(playbackEvent("PlaybackStop"));
  await h.settle(); // recovery grace running

  // The check at the end of the grace asks Jellyfin, which (still) shows nothing, but the answer
  // is slow to arrive.
  const gate = deferred();
  h.jellyfin.gate = gate;
  await h.clock.advance(GRACE, async () => {});
  await until(() => h.jellyfin.active === 1);

  // Meanwhile playback starts on another device.
  h.jellyfin.sessions = [playing({ deviceId: "phone" })];
  h.webhook(playbackEvent("PlaybackStart", { DeviceId: "phone", Id: "session-phone" }));
  await until(() => h.controller.getStatus().lastWebhook?.event === "PlaybackStart");

  // Now the old, empty answer arrives.
  h.jellyfin.gate = null;
  gate.resolve();
  await h.settle();

  assert.deepEqual(h.sabnzbd.writes, [CAP], "the stale empty answer never lifted the cap");
  assert.equal(h.controller.getStatus().controllerMode, "throttled");

  await h.advance(1_000); // the start's own follow-up check sees the phone
  await h.advance(10 * 60_000);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().decision.reason, "streams_active");
  await h.dispose();
});

Deno.test("race: the activity generation alone stops a stale empty answer (no evidence window)", async () => {
  // With the evidence window at 0 the webhook's start never counts as a stream by itself, so
  // only the generation check stands between the stale answer and an unthrottle.
  const h = harness({ settings: { enabled: true }, webhookEvidenceMs: 0 });
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  await h.start();
  await h.advance(2_000);

  h.jellyfin.sessions = [];
  h.webhook(playbackEvent("PlaybackStop"));
  await h.settle();

  const gate = deferred();
  h.jellyfin.gate = gate;
  await h.clock.advance(GRACE, async () => {});
  await until(() => h.jellyfin.active === 1);

  h.jellyfin.sessions = [playing({ deviceId: "phone" })];
  h.webhook(playbackEvent("PlaybackStart", { DeviceId: "phone", Id: "session-phone" }));
  await until(() => h.controller.getStatus().lastWebhook?.event === "PlaybackStart");

  h.jellyfin.gate = null;
  gate.resolve();
  await h.settle();

  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  assert.equal(h.controller.getStatus().decision.reason, "playback_started");
  await h.advance(1_000);
  assert.equal(h.controller.getStatus().decision.reason, "streams_active");
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  await h.dispose();
});

Deno.test("10. a slow Jellyfin request doesn't hold up the cap", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);

  const gate = deferred();
  h.jellyfin.gate = gate;
  const poll = h.controller.requestReconcile("poll"); // stuck waiting for Jellyfin
  await until(() => h.jellyfin.active === 1);
  const jellyfinCalls = h.jellyfin.calls;

  h.webhook(playbackEvent("PlaybackStart"));
  await until(() => h.sabnzbd.writes.length === 1);

  assert.deepEqual(h.sabnzbd.writes, [CAP], "capped while the poll still waits on Jellyfin");
  assert.equal(h.jellyfin.calls, jellyfinCalls, "no Jellyfin request on the way to the cap");
  assert.equal(h.jellyfin.active, 1);

  h.jellyfin.gate = null;
  gate.resolve(); // the slow poll's answer predates the start: nothing playing
  await poll;
  await h.settle();
  assert.deepEqual(h.sabnzbd.writes, [CAP], "the slow poll's older answer didn't undo it");
  assert.equal(h.sabnzbd.maxActive, 1);
  await h.dispose();
});

Deno.test("race: a start while the grace-end check is reading SABnzbd stops its unthrottle", async () => {
  const h = harness({ settings: { enabled: true } });
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  await h.start();
  await h.advance(2_000);
  h.jellyfin.sessions = [];
  h.webhook(playbackEvent("PlaybackStop"));
  await h.settle();

  // The grace ends; its check found nothing playing and is reading SABnzbd, slowly.
  const gate = deferred();
  h.sabnzbd.gate = gate;
  await h.clock.advance(GRACE, async () => {});
  await until(() => h.sabnzbd.active === 1);

  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  for (let tick = 0; tick < 50; tick++) {
    await Promise.resolve();
  }
  assert.equal(h.sabnzbd.active, 1, "the start waits its turn; it doesn't run alongside");

  h.sabnzbd.gate = null;
  gate.resolve();
  await h.settle();

  assert.deepEqual(h.sabnzbd.writes, [CAP], "no unthrottle slipped in before the start");
  assert.equal(h.sabnzbd.maxActive, 1);
  assert.equal(h.controller.getStatus().controllerMode, "throttled");
  await h.dispose();
});

Deno.test("SABnzbd requests never overlap: a reconcile waits for a slow fast-path write", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);

  const gate = deferred();
  h.sabnzbd.gate = gate;
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await until(() => h.sabnzbd.active === 1); // the cap is on its way, slowly

  const jellyfinCalls = h.jellyfin.calls;
  const manual = h.controller.reconcileNow();
  await until(() => h.jellyfin.calls === jellyfinCalls + 1); // Jellyfin is asked without waiting
  for (let tick = 0; tick < 50; tick++) {
    await Promise.resolve();
  }
  assert.equal(h.sabnzbd.active, 1, "but the reconcile's SABnzbd step waits for the write");

  h.sabnzbd.gate = null;
  gate.resolve();
  await manual;
  await h.settle();

  assert.equal(h.sabnzbd.maxActive, 1);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  await h.dispose();
});

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
  assert.equal(h.controller.getStatus().lastTrigger?.source, "manual");
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

Deno.test("turning automation off while a start is being capped restores once the write is done", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);

  const gate = deferred();
  h.sabnzbd.gate = gate;
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await until(() => h.sabnzbd.active === 1); // the cap is on its way
  const disabling = h.controller.updateSettings({ enabled: false });

  h.sabnzbd.gate = null;
  gate.resolve();
  const status = await disabling;
  await h.settle();

  assert.equal(h.sabnzbd.maxActive, 1);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0], "capped, then put back to the earlier limit");
  assert.equal(status.ownership.ownsLimit, false);
  assert.equal(h.controller.getStatus().controllerMode, "off");
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Polling as the safety net

Deno.test("11. missed webhooks are caught by adaptive polling: 15 s while idle, 60 s while capped", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();

  h.jellyfin.sessions = [playing()]; // started, but the webhook went missing
  await h.advance(IDLE - 1);
  assert.deepEqual(h.sabnzbd.writes, []);
  await h.advance(1);
  assert.deepEqual(h.sabnzbd.writes, [CAP], "caught by the idle poll");

  const callsWhileCapped = h.jellyfin.calls;
  h.jellyfin.sessions = []; // stopped, webhook missing too
  await h.advance(ACTIVE - 1);
  assert.equal(h.jellyfin.calls, callsWhileCapped, "capped: the next poll is a minute away");
  await h.advance(1);
  assert.equal(h.controller.getStatus().decision.reason, "grace_period");

  await h.advance(GRACE);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  await h.dispose();
});

Deno.test("polling cadence: every idle interval while nothing plays, every active interval while capped", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();

  let calls = h.jellyfin.calls;
  await h.advance(60_000);
  assert.equal(h.jellyfin.calls - calls, 4, "every 15 s while nothing plays");

  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();
  calls = h.jellyfin.calls;
  await h.advance(180_000);
  assert.equal(h.jellyfin.calls - calls, 3, "the start's check, then every 60 s while capped");
  await h.dispose();
});

Deno.test("a missed PlaybackStart or PlaybackStop is caught by polling", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
  await h.start();

  h.jellyfin.sessions = [playing()]; // no webhook
  await h.advance(POLL);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);

  h.jellyfin.sessions = []; // no webhook either
  await h.advance(POLL + GRACE);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  await h.dispose();
});

Deno.test("a new idle interval takes effect right away", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();

  await h.controller.updateSettings({ idlePollIntervalSeconds: 30 });
  const callsBefore = h.jellyfin.calls;
  await h.advance(29_999);
  assert.equal(h.jellyfin.calls, callsBefore);
  await h.advance(1);
  assert.equal(h.jellyfin.calls, callsBefore + 1);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Jellyfin failures

Deno.test("12. a Jellyfin outage applies the protective cap and retries every idle interval", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  assert.deepEqual(h.sabnzbd.writes, []);

  h.jellyfin.failWith = new Error("Jellyfin refused the connection");
  await h.advance(IDLE);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  let status = h.controller.getStatus();
  assert.equal(status.controllerMode, "protective_error");
  assert.equal(status.decision.reason, "jellyfin_unavailable");
  assert.equal(status.jellyfin.state, "error");

  const calls = h.jellyfin.calls;
  await h.advance(IDLE);
  assert.equal(h.jellyfin.calls, calls + 1, "retried after 15 s, not the 60 s active interval");
  assert.deepEqual(h.sabnzbd.writes, [CAP]);

  h.jellyfin.failWith = null;
  await h.advance(IDLE);
  status = h.controller.getStatus();
  assert.equal(status.jellyfin.state, "ok");
  assert.equal(status.decision.reason, "grace_period", "the grace starts once Jellyfin answers");
  await h.advance(GRACE);
  assert.deepEqual(h.sabnzbd.writes, [CAP, 0]);
  await h.dispose();
});

Deno.test("an unreachable Jellyfin applies the protective cap and keeps it without rewriting", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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

Deno.test("13. a failed fast-path write is reported and retried within the idle interval", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);

  h.sabnzbd.writeFailure = new Error("SABnzbd answered HTTP 500");
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();

  assert.deepEqual(h.sabnzbd.writes, []);
  let status = h.controller.getStatus();
  assert.equal(status.lastWebhook?.outcome, "cap_failed");
  assert.equal(status.lastWebhookThrottle?.outcome, "cap_failed");
  assert.equal(status.sabnzbd.state, "error");
  assert.equal(status.sabnzbd.lastError, "SABnzbd answered HTTP 500");
  assert.ok(status.recentErrors.some((entry) => entry.source === "sabnzbd"));
  assert.equal(status.lastReconcile?.success, false, "the follow-up check couldn't write either");
  assert.ok(h.logs.some((entry) => entry.event === "bandwidth.webhook" && entry.level === "warn"));

  h.sabnzbd.writeFailure = null;
  await h.advance(IDLE);
  assert.deepEqual(h.sabnzbd.writes, [CAP], "retried at the idle interval, not after a minute");
  status = h.controller.getStatus();
  assert.equal(status.sabnzbd.state, "ok");
  assert.equal(status.lastReconcile?.success, true);
  await h.dispose();
});

Deno.test("an unreachable SABnzbd is retried at the next poll and caught up when it's back", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
// Off, unauthenticated, malformed

Deno.test("14. with automation off, webhooks and polling change nothing", async () => {
  const h = harness();
  await h.start();
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  h.webhook(playbackEvent("PlaybackProgress", { DeviceId: "phone" }));
  await h.advance(10 * 60_000);

  assert.equal(h.jellyfin.calls, 0);
  assert.equal(h.sabnzbd.reads, 0);
  assert.deepEqual(h.sabnzbd.writes, []);
  assert.equal(h.clock.pendingTimers, 0);
  assert.equal(h.controller.getStatus().lastWebhook, null);
  await h.dispose();
});

Deno.test("15. without SHARED_SECRET a start only triggers a check: nothing is capped on its word", async () => {
  const h = harness({ settings: { enabled: true }, webhookAuth: false });
  await h.start();
  await h.advance(2_000);
  const before = h.calls.length;

  h.webhook(playbackEvent("PlaybackStart")); // Jellyfin shows nothing playing
  await h.settle();
  assert.deepEqual(h.calls.slice(before), ["jellyfin:sessions", "sab:read"]);
  assert.deepEqual(h.sabnzbd.writes, []);
  const status = h.controller.getStatus();
  assert.equal(status.lastWebhook?.outcome, "check_requested");
  assert.equal(status.fastPath.enabled, false);
  assert.match(status.fastPath.reason ?? "", /SHARED_SECRET/);

  // A request claiming to be authenticated isn't trusted while no secret is configured.
  h.webhook(playbackEvent("PlaybackStart", { DeviceId: "other" }), true);
  await h.settle();
  await h.advance(1_000);
  assert.deepEqual(h.sabnzbd.writes, []);

  // A real start is still caught, by the check, about a second later.
  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();
  await h.advance(1_000);
  assert.deepEqual(h.sabnzbd.writes, [CAP]);
  await h.dispose();
});

Deno.test("15. malformed, unsupported and test payloads trigger nothing", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.advance(2_000);
  const calls = h.calls.length;

  const start = playbackEvent("PlaybackStart");
  const { ItemId: _itemId, ...withoutItem } = start;
  for (
    const payload of [
      null,
      "PlaybackStart",
      [],
      {},
      { NotificationType: "PlaybackStart" },
      withoutItem,
      { ...start, NotificationType: "Test" },
      { ...start, NotificationType: "Generic" },
      { ...start, NotificationType: "SessionStart" },
      { ...start, NotificationType: "ItemAdded" },
      { ...start, NotificationType: "playbackstart" },
      playbackEvent("PlaybackProgress", { IsPaused: "no" }),
      playbackEvent("PlaybackProgress", { IsPaused: undefined }),
    ]
  ) {
    h.webhook(payload);
  }
  await h.settle();
  await h.advance(1_000);

  assert.equal(h.calls.length, calls, "nothing asked of Jellyfin or SABnzbd");
  assert.deepEqual(h.sabnzbd.writes, []);
  assert.equal(h.controller.getStatus().lastWebhook, null);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Restarts

Deno.test("17. after a restart with a stream still playing, startup checks and writes nothing", async () => {
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
  assert.equal(status.lastTrigger?.source, "startup");
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

Deno.test("a restart after a webhook cap keeps ownership and the limit to put back", async () => {
  const sabnzbd = new FakeSabnzbd();
  sabnzbd.limit = 25_000_000;
  const jellyfin = new FakeJellyfin();
  jellyfin.sessions = [playing({ deviceId: "tv" })];
  const first = harness({ settings: { enabled: true }, jellyfin, sabnzbd });
  await first.start(); // capped by the startup check; the owner's 25 MB/s is remembered
  await first.advance(2_000);
  first.webhook(playbackEvent("PlaybackStart"));
  await first.settle();
  assert.deepEqual(sabnzbd.writes, [CAP], "the start found the cap already on");
  await first.dispose({ keepDb: true });

  const second = harness({ db: first.db, jellyfin, sabnzbd });
  await second.start();
  assert.deepEqual(sabnzbd.writes, [CAP]);
  assert.equal(second.controller.getStatus().ownership.priorLimitBytesPerSecond, 25_000_000);
  await second.controller.updateSettings({ enabled: false });
  assert.deepEqual(sabnzbd.writes, [CAP, 25_000_000]);
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

Deno.test("starting twice runs one startup reconcile and keeps one poll timer", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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

Deno.test("stopping clears every timer and later requests and webhooks are skipped", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.controller.stop();

  assert.equal(h.clock.pendingTimers, 0);
  const outcome = await h.controller.reconcileNow();
  assert.equal(outcome.skipped, "stopped");
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();
  assert.equal(h.jellyfin.calls, 1);
  assert.deepEqual(h.sabnzbd.writes, []);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// 16. Changes made in SABnzbd by hand, and turning automation off

Deno.test("16. after a webhook cap, a limit changed by hand is set back and the earlier limit is restored on turning off", async () => {
  const h = harness({ settings: { enabled: true } });
  h.sabnzbd.limit = 25_000_000; // the owner's own limit
  await h.start();
  assert.deepEqual(h.sabnzbd.writes, [0], "nothing playing: unrestricted");
  await h.advance(2_000);

  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();
  assert.deepEqual(h.sabnzbd.writes, [0, CAP]);

  h.sabnzbd.limit = 20_000_000; // changed by hand
  await h.advance(ACTIVE);
  assert.deepEqual(h.sabnzbd.writes, [0, CAP, CAP]);
  assert.match(h.controller.getStatus().notice?.message ?? "", /changed outside ObservaRR/);
  assert.equal(h.controller.getStatus().conflict.externalChanges, 1);

  const status = await h.controller.updateSettings({ enabled: false });
  assert.deepEqual(h.sabnzbd.writes, [0, CAP, CAP, 25_000_000]);
  assert.equal(status.ownership.ownsLimit, false);
  await h.dispose();
});

Deno.test("a limit changed by hand while capped is set back once and reported", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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

Deno.test("turning automation off puts back the limit SABnzbd had before", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
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
  assert.equal(status.lastTrigger?.source, "manual");
  assert.equal(status.controllerMode, "off");
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
  assert.equal(h.controller.getStatus().lastTrigger?.source, "settings");

  const status = await h.controller.updateSettings({ throttle: { value: 4, unit: "MBps" } });
  assert.deepEqual(h.sabnzbd.writes, [CAP, 4_000_000]);
  assert.equal(status.settings.throttleUnit, "MBps");
  assert.equal(status.settings.throttleValue, 4);
  assert.equal(h.store.getSettings().throttleBytesPerSecond, 4_000_000);
  await h.dispose();
});

Deno.test("a webhook start uses the saved cap, whatever unit it was entered in", async () => {
  const h = harness({ settings: { enabled: true } });
  await h.start();
  await h.controller.updateSettings({ throttle: { value: 12.5, unit: "MBps" } });
  await h.advance(2_000);

  h.jellyfin.sessions = [playing({ deviceId: "tv" })];
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();

  assert.deepEqual(h.sabnzbd.writes, [12_500_000], "12.5 MB/s = 100 Mb/s, sent as exact bytes");
  assert.equal(h.store.getSettings().throttleBytesPerSecond, 12_500_000);
  await h.dispose();
});

// ---------------------------------------------------------------------------------------------
// Secrets

Deno.test("API keys never reach the status, the error list or the logs", async () => {
  const h = harness({ settings: { enabled: true, ...POLL_5S } });
  await h.start();

  h.jellyfin.failWith = new Error(
    `error sending request for url (http://jellyfin:8096/Sessions?api_key=${JELLYFIN_KEY})`,
  );
  h.sabnzbd.writeFailure = new Error(`request to http://sab:8080/api?apikey=${SABNZBD_KEY} failed`);
  await h.advance(POLL);
  h.webhook(playbackEvent("PlaybackStart"));
  await h.settle();

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
  for (let tick = 0; tick < 200 && !condition(); tick++) {
    await Promise.resolve();
  }
  assert.ok(condition(), "condition never held");
}
