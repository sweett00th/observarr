import assert from "node:assert/strict";
import {
  classifyJellyfinWebhook,
  decideMode,
  evaluatePlayback,
  limitsMatch,
  PauseTracker,
  playbackStreamKey,
  sessionStreamKey,
  staleSessionMs,
} from "../../server/bandwidth/policy.ts";
import {
  BYTES_PER_MEGABIT,
  BYTES_PER_MEGABYTE,
  formatLimit,
  fromBytesPerSecond,
  toBytesPerSecond,
} from "../../server/bandwidth/units.ts";
import { CAP, playbackEvent, playing } from "./helpers.ts";

const NOW = Date.parse("2026-11-09T20:00:00.000Z");
const grace = { pausedPolicy: "grace" as const, pausedGraceMs: 120_000 };

Deno.test("megabits and megabytes: 80 Mb/s is 10 MB/s is 10,000,000 bytes/s", () => {
  assert.equal(BYTES_PER_MEGABIT, 125_000);
  assert.equal(BYTES_PER_MEGABYTE, 1_000_000);
  assert.equal(toBytesPerSecond(80, "Mbps"), CAP);
  assert.equal(toBytesPerSecond(10, "MBps"), CAP);
  assert.equal(fromBytesPerSecond(CAP, "Mbps"), 80);
  assert.equal(fromBytesPerSecond(CAP, "MBps"), 10);
  assert.equal(toBytesPerSecond(12.5, "MBps"), 12_500_000);
  assert.equal(formatLimit(CAP), "80 Mb/s (10 MB/s)");
  assert.equal(formatLimit(0), "unlimited");
  assert.equal(formatLimit(null), "unknown");
});

Deno.test("decideMode: playback caps, an unreadable Jellyfin caps, idle lifts after the grace", () => {
  const base = { now: NOW, inactiveSince: null, recoveryGraceMs: 30_000 };

  assert.deepEqual(
    decideMode({ ...base, previousMode: "unrestricted", countedStreams: 1 }),
    { mode: "throttled", reason: "streams_active", inactiveSince: null, graceUntil: null },
  );
  assert.deepEqual(
    decideMode({ ...base, previousMode: "unrestricted", countedStreams: null }),
    { mode: "throttled", reason: "jellyfin_unavailable", inactiveSince: null, graceUntil: null },
  );
  assert.deepEqual(
    decideMode({
      ...base,
      previousMode: "throttled",
      countedStreams: null,
      inactiveSince: NOW - 60_000,
    }),
    { mode: "throttled", reason: "jellyfin_unavailable", inactiveSince: null, graceUntil: null },
    "an outage never counts toward the grace",
  );
  assert.deepEqual(
    decideMode({ ...base, previousMode: "unrestricted", countedStreams: 0 }),
    { mode: "unrestricted", reason: "idle", inactiveSince: NOW, graceUntil: null },
  );
  assert.deepEqual(
    decideMode({ ...base, previousMode: "throttled", countedStreams: 0 }),
    { mode: "throttled", reason: "grace_period", inactiveSince: NOW, graceUntil: NOW + 30_000 },
  );
  assert.deepEqual(
    decideMode({
      ...base,
      previousMode: "throttled",
      countedStreams: 0,
      inactiveSince: NOW - 30_000,
    }),
    { mode: "unrestricted", reason: "idle", inactiveSince: NOW - 30_000, graceUntil: null },
  );
  assert.equal(
    decideMode({ ...base, previousMode: "throttled", countedStreams: 0, recoveryGraceMs: 0 }).mode,
    "unrestricted",
    "a zero grace lifts the cap at once",
  );
});

Deno.test("limitsMatch: no limit is exactly 0; limits match within a small tolerance", () => {
  assert.ok(limitsMatch(0, 0));
  assert.ok(!limitsMatch(CAP, 0));
  assert.ok(!limitsMatch(0, CAP));
  assert.ok(limitsMatch(CAP, CAP));
  assert.ok(limitsMatch(CAP + 1024, CAP));
  assert.ok(!limitsMatch(10_485_760, CAP), "10 MiB/s is not 10 MB/s");
  assert.ok(!limitsMatch(20_000_000, CAP));
});

Deno.test("evaluatePlayback counts playing streams of every kind and reports when that changes", () => {
  const tracker = new PauseTracker();
  const evaluation = evaluatePlayback(
    {
      totalSessions: 6,
      playing: [
        playing({ playMethod: "Transcode", lastSeenAt: NOW - 10_000 }),
        playing({ playMethod: "DirectPlay" }),
        playing({ isPaused: true, pausedAt: NOW - 60_000 }),
        playing({ isPaused: true, pausedAt: NOW - 600_000 }),
        playing({ lastSeenAt: NOW - staleSessionMs }),
      ],
    },
    NOW,
    grace,
    tracker,
  );

  assert.equal(evaluation.countedStreams, 3);
  assert.equal(evaluation.playing, 2);
  assert.equal(evaluation.pausedCounted, 1);
  assert.equal(evaluation.pausedIgnored, 1);
  assert.equal(evaluation.stale, 1);
  assert.equal(evaluation.transcoding, 1);
  assert.equal(evaluation.totalSessions, 6);
  assert.equal(evaluation.nextChangeAt, NOW + 60_000, "the paused stream's grace ends first");
});

Deno.test("evaluatePlayback paused policies", () => {
  const session = playing({ isPaused: true, pausedAt: NOW - 3_600_000 });
  const snapshot = { totalSessions: 1, playing: [session] };

  assert.equal(
    evaluatePlayback(
      snapshot,
      NOW,
      { pausedPolicy: "active", pausedGraceMs: 0 },
      new PauseTracker(),
    )
      .countedStreams,
    1,
  );
  assert.equal(
    evaluatePlayback(
      snapshot,
      NOW,
      { pausedPolicy: "idle", pausedGraceMs: 3_600_001 },
      new PauseTracker(),
    )
      .countedStreams,
    0,
  );
  assert.equal(evaluatePlayback(snapshot, NOW, grace, new PauseTracker()).countedStreams, 0);
});

Deno.test("PauseTracker times pauses for Jellyfin versions without LastPausedDate", () => {
  const tracker = new PauseTracker();
  const session = playing({ isPaused: true });
  const snapshot = { totalSessions: 1, playing: [session] };

  assert.equal(evaluatePlayback(snapshot, NOW, grace, tracker).pausedCounted, 1);
  assert.equal(evaluatePlayback(snapshot, NOW + 119_999, grace, tracker).pausedCounted, 1);
  assert.equal(evaluatePlayback(snapshot, NOW + 120_000, grace, tracker).pausedIgnored, 1);

  // Resuming forgets the pause; pausing again starts a new grace.
  evaluatePlayback(
    { totalSessions: 1, playing: [{ ...session, isPaused: false }] },
    NOW + 130_000,
    grace,
    tracker,
  );
  assert.equal(evaluatePlayback(snapshot, NOW + 140_000, grace, tracker).pausedCounted, 1);
});

Deno.test("classifyJellyfinWebhook: starts and resumes, pauses and stops, nothing else", () => {
  const known = new Map([["tv", false], ["phone", true]]);
  const kind = (payload: unknown) => classifyJellyfinWebhook(payload, known)?.kind ?? null;
  const label = (payload: unknown) => classifyJellyfinWebhook(payload, known)?.label ?? null;
  const progress = (DeviceId: string, IsPaused: boolean) =>
    playbackEvent("PlaybackProgress", { DeviceId, IsPaused });

  assert.deepEqual(classifyJellyfinWebhook(playbackEvent("PlaybackStart"), known), {
    kind: "start",
    streamKey: "tv",
    label: "PlaybackStart",
  });
  assert.equal(kind(playbackEvent("PlaybackStop")), "stop");

  // The plugin has no pause or resume event: IsPaused changes inside PlaybackProgress.
  assert.equal(kind(progress("tv", false)), null, "a ping that changes nothing");
  assert.equal(label(progress("tv", true)), "PlaybackProgress (paused)");
  assert.equal(kind(progress("tv", true)), "pause");
  assert.equal(label(progress("phone", false)), "PlaybackProgress (resumed)");
  assert.equal(kind(progress("phone", false)), "resume");
  assert.equal(label(progress("new", false)), "PlaybackProgress (new stream)");
  assert.equal(kind(progress("new", false)), "resume");
  assert.equal(label(progress("new", true)), "PlaybackProgress (paused, new stream)");
  assert.equal(kind(progress("new", true)), "pause");

  // Other events and malformed payloads are nothing.
  for (const type of ["ItemAdded", "SessionStart", "UserDataSaved", "Generic", "Test"]) {
    assert.equal(kind(playbackEvent("PlaybackStart", { NotificationType: type })), null, type);
  }
  assert.equal(kind("not an object"), null);
  assert.equal(kind(null), null);
  assert.equal(kind({ NotificationType: "PlaybackStart" }), null, "no ItemId");
  assert.equal(kind(playbackEvent("PlaybackProgress", { IsPaused: "true" })), null);
  assert.equal(kind(playbackEvent("PlaybackProgress", { IsPaused: undefined })), null);
});

Deno.test("webhook and /Sessions stream keys line up", () => {
  const event = (overrides: Record<string, unknown>) =>
    playbackStreamKey(playbackEvent("PlaybackStart", overrides));

  assert.equal(event({}), "tv");
  assert.equal(event({ DeviceId: undefined }), "session:session-tv");
  assert.equal(event({ DeviceId: undefined, Id: undefined }), "user:user-1:item-1");
  assert.equal(event({ ItemId: undefined }), null);

  assert.equal(sessionStreamKey(playing({ deviceId: "tv" })), "tv");
  assert.equal(
    sessionStreamKey(playing({ deviceId: null, id: "session-tv" })),
    "session:session-tv",
    "a session without a DeviceId matches a webhook without one",
  );
});
