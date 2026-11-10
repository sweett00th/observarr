import assert from "node:assert/strict";
import { DB } from "sqlite";
import {
  BandwidthController,
  type Clock,
  type TimerHandle,
} from "../../server/bandwidth/controller.ts";
import {
  type BandwidthControllerState,
  type BandwidthSettings,
  SqliteBandwidthStore,
} from "../../server/bandwidth/settings.ts";
import { runMigrations } from "../../server/db/migrations.ts";
import type {
  JellyfinPlaybackSession,
  JellyfinSessionSource,
  JellyfinSessionsSnapshot,
} from "../../server/integrations/jellyfin/sessions.ts";
import type { SabnzbdApi, SabnzbdQueueStatus } from "../../server/integrations/sabnzbd/client.ts";

export const JELLYFIN_KEY = "jf-test-key-0123456789abcdef";
export const SABNZBD_KEY = "sab-test-key-fedcba9876543210";
/** The default cap: 80 Mb/s = 10 MB/s. */
export const CAP = 10_000_000;
export const START = Date.parse("2026-11-09T20:00:00.000Z");

/** A clock whose time only moves when a test moves it. Timers fire in order as it does. */
export class FakeClock implements Clock {
  #now: number;
  #nextId = 1;
  #timers = new Map<number, { at: number; callback: () => void }>();

  constructor(start = START) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  monotonic(): number {
    return this.#now;
  }

  /** Moves time forward without firing timers, e.g. to make a request take a while. */
  bump(ms: number): void {
    this.#now += ms;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  /** Moves time forward, firing due timers in order and letting work settle after each. */
  async advance(ms: number, settle: () => Promise<void>): Promise<void> {
    const target = this.#now + ms;

    while (true) {
      let next: { id: number; at: number; callback: () => void } | null = null;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && (!next || timer.at < next.at)) {
          next = { id, ...timer };
        }
      }

      if (!next) {
        break;
      }

      this.#timers.delete(next.id);
      this.#now = next.at;
      next.callback();
      await settle();
    }

    this.#now = target;
    await settle();
  }
}

export type Deferred = { promise: Promise<void>; resolve: () => void };

export function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Jellyfin's /Sessions, as the tests want it. */
export class FakeJellyfin implements JellyfinSessionSource {
  sessions: JellyfinPlaybackSession[] = [];
  /** Connected sessions with nothing playing. */
  idleSessions = 0;
  failWith: Error | null = null;
  /** While set, requests wait for it. */
  gate: Deferred | null = null;
  calls = 0;
  active = 0;
  maxActive = 0;
  /** Shared with FakeSabnzbd, to check the order of requests. */
  log: string[] = [];

  async fetchSessions(): Promise<JellyfinSessionsSnapshot> {
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.log.push("jellyfin:sessions");

    // The answer reflects the moment the request reached Jellyfin; a gated (slow) response
    // arrives later carrying that older state, which is what the race tests need.
    const snapshot: JellyfinSessionsSnapshot = {
      totalSessions: this.sessions.length + this.idleSessions,
      playing: this.sessions.map((session) => ({ ...session })),
    };
    const failure = this.failWith;

    try {
      if (this.gate) {
        await this.gate.promise;
      }

      if (failure) {
        throw failure;
      }

      return snapshot;
    } finally {
      this.active -= 1;
    }
  }
}

/** SABnzbd, holding its own speed limit like the real one. */
export class FakeSabnzbd implements SabnzbdApi {
  /** Bytes/s; 0 is no limit. */
  limit = 0;
  paused = false;
  downloadBytesPerSecond = 40_000_000;
  readFailure: Error | null = null;
  writeFailure: Error | null = null;
  gate: Deferred | null = null;
  reads = 0;
  writes: number[] = [];
  active = 0;
  maxActive = 0;
  /** Shared with FakeJellyfin, to check the order of requests. */
  log: string[] = [];
  /** Runs inside each write, before it succeeds or fails (e.g. to let fake time pass). */
  onWrite: (() => void) | null = null;

  async getQueueStatus(): Promise<SabnzbdQueueStatus> {
    return await this.#tracked(() => {
      this.reads += 1;
      this.log.push("sab:read");
      if (this.readFailure) {
        throw this.readFailure;
      }

      return {
        speedLimitBytesPerSecond: this.limit,
        speedLimitPercent: this.limit > 0 ? 100 : 0,
        downloadBytesPerSecond: this.limit > 0
          ? Math.min(this.limit, this.downloadBytesPerSecond)
          : this.downloadBytesPerSecond,
        queueStatus: this.paused ? "Paused" : "Downloading",
        paused: this.paused,
        version: "4.5.5",
      };
    });
  }

  async setSpeedLimit(bytesPerSecond: number): Promise<void> {
    await this.#tracked(() => {
      this.onWrite?.();
      if (this.writeFailure) {
        this.log.push(`sab:write-failed:${bytesPerSecond}`);
        throw this.writeFailure;
      }

      this.log.push(`sab:write:${bytesPerSecond}`);
      this.writes.push(bytesPerSecond);
      this.limit = bytesPerSecond;
    });
  }

  async #tracked<T>(work: () => T): Promise<T> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.gate) {
        await this.gate.promise;
      }
      return work();
    } finally {
      this.active -= 1;
    }
  }
}

let sessionCounter = 0;

/** A session with something playing. Unknown activity times count as fresh. */
export function playing(overrides: Partial<JellyfinPlaybackSession> = {}): JellyfinPlaybackSession {
  sessionCounter += 1;
  return {
    id: `session-${sessionCounter}`,
    deviceId: `device-${sessionCounter}`,
    userName: `user-${sessionCounter}`,
    client: "Jellyfin Web",
    deviceName: "Living Room TV",
    itemId: `item-${sessionCounter}`,
    itemName: "A Movie",
    isPaused: false,
    playMethod: "DirectPlay",
    pausedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

/**
 * What the Jellyfin Webhook plugin sends for a playback event with "Send All Properties" on
 * (trimmed to the fields that matter here). Pauses and resumes are PlaybackProgress with IsPaused.
 */
export function playbackEvent(
  type: "PlaybackStart" | "PlaybackProgress" | "PlaybackStop",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    NotificationType: type,
    ServerName: "jellyfin",
    Name: "A Movie",
    ItemId: "item-1",
    ItemType: "Movie",
    PlaybackPositionTicks: 0,
    IsPaused: false,
    IsAutomated: false,
    DeviceId: "tv",
    DeviceName: "Living Room TV",
    ClientName: "Jellyfin Web",
    NotificationUsername: "someone",
    UserId: "user-1",
    Id: "session-tv",
    UtcTimestamp: "2026-11-09T20:00:00.0000000Z",
    ...overrides,
  };
}

/** An in-memory database with every migration applied (or only those through a version). */
export function createTestDb(options: { throughVersion?: number } = {}): DB {
  const db = new DB();
  db.execute("PRAGMA foreign_keys = ON");
  const log = console.log;
  console.log = () => {};
  try {
    runMigrations(db, options);
  } finally {
    console.log = log;
  }
  return db;
}

export type LogEntry = { level: string; event: string; details: Record<string, unknown> };

export type Harness = Awaited<ReturnType<typeof harness>>;

export function harness(options: {
  db?: DB;
  settings?: Partial<BandwidthSettings>;
  state?: Partial<BandwidthControllerState>;
  clock?: FakeClock;
  jellyfin?: FakeJellyfin | null;
  sabnzbd?: FakeSabnzbd | null;
  /** Whether SHARED_SECRET is configured (default: yes, so authenticated webhooks cap at once). */
  webhookAuth?: boolean;
  /** How long a webhook-reported start counts before Jellyfin lists it (default 60 s). */
  webhookEvidenceMs?: number;
} = {}) {
  const db = options.db ?? createTestDb();
  const store = new SqliteBandwidthStore(db);
  if (options.settings) {
    store.saveSettings({ ...store.getSettings(), ...options.settings });
  }
  if (options.state) {
    store.saveState({ ...store.getState(), ...options.state });
  }

  const clock = options.clock ?? new FakeClock();
  const jellyfin = options.jellyfin === undefined ? new FakeJellyfin() : options.jellyfin;
  const sabnzbd = options.sabnzbd === undefined ? new FakeSabnzbd() : options.sabnzbd;
  const calls: string[] = [];
  if (jellyfin) jellyfin.log = calls;
  if (sabnzbd) sabnzbd.log = calls;
  const logs: LogEntry[] = [];
  // consoleBandwidthLogger writes `event` and `at` first and spreads the details after them, so a
  // detail with either name would replace the log line's name or time. Checked at dispose.
  const clashingLogs: string[] = [];
  const webhookAuth = options.webhookAuth ?? true;
  const controller = new BandwidthController({
    store,
    jellyfin,
    sabnzbd,
    clock,
    logger: (level, event, details) => {
      if ("event" in details || "at" in details) {
        clashingLogs.push(event);
      }
      logs.push({ level, event, details });
    },
    secrets: [JELLYFIN_KEY, SABNZBD_KEY],
    webhookAuthConfigured: () => webhookAuth,
    webhookEvidenceMs: options.webhookEvidenceMs,
  });
  const settle = () => controller.whenIdle();

  return {
    db,
    store,
    clock,
    // Non-null in every test that doesn't pass null on purpose.
    jellyfin: jellyfin as FakeJellyfin,
    sabnzbd: sabnzbd as FakeSabnzbd,
    controller,
    logs,
    /** Jellyfin and SABnzbd requests, in order: "jellyfin:sessions", "sab:read", "sab:write:N". */
    calls,
    settle,
    advance: (ms: number) => clock.advance(ms, settle),
    /** Delivers a webhook the way the route does: authenticated unless said otherwise. */
    webhook(payload: unknown, authenticated = webhookAuth) {
      controller.handleJellyfinWebhook(payload, { authenticated });
    },
    /** Starts the controller and waits for its startup reconcile. */
    async start() {
      controller.start();
      await settle();
    },
    async dispose(options: { keepDb?: boolean } = {}) {
      await controller.stop();
      if (!options.keepDb) {
        db.close();
      }
      assert.deepEqual(clashingLogs, [], "log details named `event` or `at` hide the line's own");
    },
  };
}
