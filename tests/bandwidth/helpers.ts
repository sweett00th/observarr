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

  async fetchSessions(): Promise<JellyfinSessionsSnapshot> {
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    try {
      if (this.gate) {
        await this.gate.promise;
      }

      if (this.failWith) {
        throw this.failWith;
      }

      return {
        totalSessions: this.sessions.length + this.idleSessions,
        playing: this.sessions.map((session) => ({ ...session })),
      };
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

  async getQueueStatus(): Promise<SabnzbdQueueStatus> {
    return await this.#tracked(() => {
      this.reads += 1;
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
      if (this.writeFailure) {
        throw this.writeFailure;
      }

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

/** An in-memory database with every migration applied. */
export function createTestDb(): DB {
  const db = new DB();
  db.execute("PRAGMA foreign_keys = ON");
  const log = console.log;
  console.log = () => {};
  try {
    runMigrations(db);
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
  const logs: LogEntry[] = [];
  const controller = new BandwidthController({
    store,
    jellyfin,
    sabnzbd,
    clock,
    logger: (level, event, details) => logs.push({ level, event, details }),
    secrets: [JELLYFIN_KEY, SABNZBD_KEY],
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
    settle,
    advance: (ms: number) => clock.advance(ms, settle),
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
    },
  };
}
