import type { JellyfinSessionSource } from "../integrations/jellyfin/sessions.ts";
import type { SabnzbdApi, SabnzbdQueueStatus } from "../integrations/sabnzbd/client.ts";
import { redactSecrets, UpstreamRequestError } from "../lib/upstream.ts";
import {
  classifyJellyfinWebhook,
  decideMode,
  type DecisionReason,
  evaluatePlayback,
  limitsMatch,
  type ModeDecision,
  PauseTracker,
  type PlaybackEvaluation,
  type PlaybackWebhook,
  sessionStreamKey,
  type SessionVerdict,
} from "./policy.ts";
import {
  applySettingsPatch,
  type BandwidthControllerState,
  type BandwidthLimitChange,
  type BandwidthMode,
  type BandwidthSettings,
  type BandwidthSettingsPatch,
  type BandwidthStore,
  type PausedPolicy,
} from "./settings.ts";
import { formatLimit, fromBytesPerSecond, type ThrottleUnit } from "./units.ts";

/** Whatever a Clock's setTimeout returns; only ever handed back to its clearTimeout. */
export type TimerHandle = unknown;

export interface Clock {
  /** Wall-clock epoch ms, for timestamps and timers. */
  now(): number;
  /** A monotonic ms counter for measuring durations (performance.now() in production). */
  monotonic(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type BandwidthLogLevel = "info" | "warn" | "error";
export type BandwidthLogger = (
  level: BandwidthLogLevel,
  event: string,
  details: Record<string, unknown>,
) => void;

/** One JSON line per event, like the rest of the server's structured logs. */
export const consoleBandwidthLogger: BandwidthLogger = (level, event, details) => {
  const line = JSON.stringify({ event, at: new Date().toISOString(), ...details });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
};

/** Automation was asked to do something its environment can't support. */
export class BandwidthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BandwidthConfigurationError";
  }
}

export type BandwidthControllerOptions = {
  store: BandwidthStore;
  /** null when JELLYFIN_URL or JELLYFIN_API_KEY is missing. */
  jellyfin: JellyfinSessionSource | null;
  /** null when SABNZBD_URL or SABNZBD_API_KEY is missing. */
  sabnzbd: SabnzbdApi | null;
  clock?: Clock;
  logger?: BandwidthLogger;
  /** Redacted from any error text before it is kept or logged. */
  secrets?: ReadonlyArray<string | undefined>;
  /** The least time between reconciles started by webhooks. */
  webhookMinIntervalMs?: number;
  /** How often to retry putting SABnzbd's prior limit back when that failed. */
  restoreRetryMs?: number;
  /**
   * Whether webhook requests are authenticated (SHARED_SECRET is set, so the webhook route turns
   * away requests without it). Only then may a webhook write SABnzbd's limit directly.
   */
  webhookAuthConfigured?: () => boolean;
  /** How long a webhook-reported start keeps the cap on before Jellyfin's sessions list it. */
  webhookEvidenceMs?: number;
};

/** What the webhook route knows about a Jellyfin webhook request. */
export type JellyfinWebhookContext = {
  /** The request passed the SHARED_SECRET check (false when no secret is configured). */
  authenticated?: boolean;
  /** When the request arrived, on the controller clock's monotonic scale. */
  receivedAt?: number;
};

export type TriggerSource = "webhook" | "poll" | "manual" | "startup" | "settings";

/** The controller's state as the dashboard names it. */
export type ControllerMode =
  | "off"
  | "unrestricted"
  | "throttled"
  | "recovery_grace"
  | "protective_error";

export type WebhookOutcome = "capped" | "already_capped" | "cap_failed" | "check_requested";

/**
 * Timing of the last webhook that made the fast path write SABnzbd, in ms on a monotonic clock:
 * from ObservaRR receiving the webhook to the request to SABnzbd, the request itself, and from
 * receipt to SABnzbd's acknowledgement. It starts when the webhook reached ObservaRR, not when
 * someone pressed Play: Jellyfin's own delay in sending the webhook isn't included.
 */
export type WebhookThrottleTiming = {
  event: string;
  receivedAt: string;
  outcome: "capped" | "cap_failed";
  receivedToRequestMs: number | null;
  requestMs: number | null;
  receivedToAckMs: number | null;
  /** Receipt to the end of the follow-up reconcile that checked Jellyfin's sessions. */
  receivedToReconcileMs: number | null;
};

export type ConnectionState = "unknown" | "ok" | "error" | "not_configured";

export type ConnectionStatus = {
  state: ConnectionState;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
};

export type ReconcileOutcome = {
  trigger: string;
  at: string;
  /** Automation is off: Jellyfin and SABnzbd were only looked at. */
  checkOnly: boolean;
  success: boolean;
  mode: BandwidthMode | null;
  reason: DecisionReason | null;
  countedStreams: number | null;
  change: { fromBytesPerSecond: number; toBytesPerSecond: number } | null;
  skipped: "stopped" | null;
};

export type BandwidthStatus = {
  settings: {
    enabled: boolean;
    throttleBytesPerSecond: number;
    throttleUnit: ThrottleUnit;
    /** The cap in throttleUnit. */
    throttleValue: number;
    idlePollIntervalSeconds: number;
    activePollIntervalSeconds: number;
    recoveryGraceSeconds: number;
    pausedPolicy: PausedPolicy;
    pausedGraceSeconds: number;
    updatedAt: string | null;
  };
  configured: { jellyfin: boolean; sabnzbd: boolean };
  lifecycle: "stopped" | "running" | "stopping";
  mode: BandwidthMode;
  controllerMode: ControllerMode;
  /** Whether a playback-start webhook caps SABnzbd directly (needs SHARED_SECRET). */
  fastPath: { enabled: boolean; reason: string | null };
  lastTrigger: { source: TriggerSource; detail: string; at: string } | null;
  lastWebhook: { event: string; outcome: WebhookOutcome; at: string } | null;
  lastWebhookThrottle: WebhookThrottleTiming | null;
  decision: {
    reason: DecisionReason | "disabled" | null;
    graceUntil: string | null;
    nextCheckAt: string | null;
  };
  playback: {
    observedAt: string;
    countedStreams: number;
    playing: number;
    pausedCounted: number;
    pausedIgnored: number;
    stale: number;
    transcoding: number;
    totalSessions: number;
    /** Starts reported by webhooks that Jellyfin's sessions don't list yet; they count too. */
    pendingWebhookStreams: number;
    streams: Array<{
      userName: string | null;
      client: string | null;
      deviceName: string | null;
      itemName: string | null;
      playMethod: string | null;
      isPaused: boolean;
      verdict: SessionVerdict;
      counted: boolean;
    }>;
  } | null;
  jellyfin: ConnectionStatus;
  sabnzbd: ConnectionStatus & {
    observedAt: string | null;
    speedLimitBytesPerSecond: number | null;
    speedLimitPercent: number | null;
    downloadBytesPerSecond: number | null;
    queueStatus: string | null;
    paused: boolean | null;
    version: string | null;
  };
  lastReconcile: { at: string; trigger: string; success: boolean; checkOnly: boolean } | null;
  lastSuccessfulReconcileAt: string | null;
  lastChange: BandwidthLimitChange | null;
  ownership: {
    ownsLimit: boolean;
    priorLimitBytesPerSecond: number | null;
    appliedLimitBytesPerSecond: number | null;
    restorePending: boolean;
  };
  conflict: {
    suspected: boolean;
    externalChanges: number;
    windowMinutes: number;
    lastAt: string | null;
  };
  notice: { at: string; message: string } | null;
  recentErrors: Array<{
    source: ErrorSource;
    message: string;
    firstAt: string;
    lastAt: string;
    count: number;
  }>;
};

type ErrorSource = "jellyfin" | "sabnzbd" | "controller";

type ErrorEntry = {
  source: ErrorSource;
  message: string;
  firstAt: number;
  lastAt: number;
  count: number;
};

const externalChangeWindowMs = 15 * 60_000;
/** This many outside changes inside the window suggests another controller is fighting this one. */
const externalChangeThreshold = 3;
const maxRecentErrors = 20;
const minimumPollDelayMs = 250;
/** Long enough for Jellyfin's /Sessions to list a stream its webhook reported. */
const defaultWebhookEvidenceMs = 60_000;

/** A mutex whose "high" waiters are let in before "normal" ones. */
class PriorityLock {
  #busy = false;
  readonly #high: Array<() => void> = [];
  readonly #normal: Array<() => void> = [];

  async run<T>(priority: "high" | "normal", task: () => Promise<T>): Promise<T> {
    if (this.#busy) {
      await new Promise<void>((resolve) => {
        (priority === "high" ? this.#high : this.#normal).push(resolve);
      });
    } else {
      this.#busy = true;
    }

    try {
      return await task();
    } finally {
      const next = this.#high.shift() ?? this.#normal.shift();
      if (next) {
        next(); // the lock passes straight to the next waiter
      } else {
        this.#busy = false;
      }
    }
  }
}

/**
 * Caps SABnzbd's download speed while anything plays on Jellyfin.
 *
 * Event first: an authenticated playback-start (or resume) webhook writes the cap at once,
 * without asking Jellyfin or reading SABnzbd first, and a reconcile then checks Jellyfin's
 * sessions. Stops and pauses only ever trigger that check; the cap comes off after the recovery
 * grace, once Jellyfin confirms nothing is playing. Polling (a short interval while idle, a long
 * one while capped) is the safety net for missed webhooks, stale sessions and outside changes.
 *
 * Reconciles, settings changes and restores run through one queue, so two never overlap, and a
 * check asked for while another waits joins it. Every SABnzbd write goes through one lock that
 * playback starts jump to the front of, so a start never waits behind a slow Jellyfin request and
 * two writes never overlap. A webhook-reported start bumps an activity generation: a reconcile
 * whose Jellyfin read began before it can't start the grace period or lift the cap, and the start
 * itself counts as a stream until Jellyfin lists it (or for webhookEvidenceMs).
 *
 * While enabled it owns SABnzbd's speed limit: SABnzbd is only written to when the wanted limit
 * changes or SABnzbd drifted from it (a SABnzbd restart, a change by hand, another controller).
 * The limit SABnzbd had before automation first changed it is remembered and put back when
 * automation is turned off, unless someone changed the limit since.
 */
export class BandwidthController {
  readonly #store: BandwidthStore;
  readonly #jellyfin: JellyfinSessionSource | null;
  readonly #sabnzbd: SabnzbdApi | null;
  readonly #clock: Clock;
  readonly #log: BandwidthLogger;
  readonly #secrets: ReadonlyArray<string | undefined>;
  readonly #webhookMinIntervalMs: number;
  readonly #restoreRetryMs: number;
  readonly #webhookAuthConfigured: () => boolean;
  readonly #webhookEvidenceMs: number;
  /** One SABnzbd write (with any read it needs first) at a time; playback starts go first. */
  readonly #writeLock = new PriorityLock();
  /** Bumped by every webhook-reported start or resume; see #reconcile. */
  #activityGeneration = 0;
  /** What webhooks said about each stream (keyed like sessionStreamKey): when, and paused or not. */
  readonly #webhookStreams = new Map<string, { at: number; paused: boolean }>();
  readonly #fastPathTasks = new Set<Promise<void>>();
  #lastTrigger: { source: TriggerSource; detail: string; at: number } | null = null;
  #lastWebhook: { event: string; outcome: WebhookOutcome; at: number } | null = null;
  #lastWebhookThrottle: WebhookThrottleTiming | null = null;
  /** A fast-path write whose follow-up reconcile hasn't finished yet. */
  #awaitingCheck: { timing: WebhookThrottleTiming; receivedAt: number } | null = null;

  #settings: BandwidthSettings;
  #state: BandwidthControllerState;
  #lifecycle: "stopped" | "running" | "stopping" = "stopped";

  #chain: Promise<void> = Promise.resolve();
  #inFlight = 0;
  #queued: { promise: Promise<ReconcileOutcome>; triggers: string[] } | null = null;

  #pollTimer: TimerHandle | null = null;
  #webhookTimer: TimerHandle | null = null;
  #restoreTimer: TimerHandle | null = null;
  #nextCheckAt: number | null = null;
  #lastReconcileStartedAt = Number.NEGATIVE_INFINITY;

  #inactiveSince: number | null = null;
  #graceUntil: number | null = null;
  #decisionReason: DecisionReason | null = null;
  readonly #pauseTracker = new PauseTracker();
  #playback: { at: number; evaluation: PlaybackEvaluation } | null = null;
  /** Stream key -> IsPaused for each stream in the last successful Jellyfin check. */
  #knownStreams: Map<string, boolean> | null = null;
  #queue: { at: number; status: SabnzbdQueueStatus } | null = null;
  #jellyfinStatus: ConnectionStatus;
  #sabnzbdStatus: ConnectionStatus;
  #lastReconcile: { at: number; trigger: string; success: boolean; checkOnly: boolean } | null =
    null;
  #lastSuccessfulReconcileAt: number | null = null;
  #externalChanges: number[] = [];
  #conflictLogged = false;
  #notice: { at: number; message: string } | null = null;
  #recentErrors: ErrorEntry[] = [];

  constructor(options: BandwidthControllerOptions) {
    this.#store = options.store;
    this.#jellyfin = options.jellyfin;
    this.#sabnzbd = options.sabnzbd;
    this.#clock = options.clock ?? systemClock;
    this.#log = options.logger ?? consoleBandwidthLogger;
    this.#secrets = options.secrets ?? [];
    this.#webhookMinIntervalMs = options.webhookMinIntervalMs ?? 1000;
    this.#restoreRetryMs = options.restoreRetryMs ?? 30_000;
    this.#webhookAuthConfigured = options.webhookAuthConfigured ?? (() => false);
    this.#webhookEvidenceMs = options.webhookEvidenceMs ?? defaultWebhookEvidenceMs;
    this.#settings = this.#store.getSettings();
    this.#state = this.#store.getState();
    this.#jellyfinStatus = initialConnectionStatus(this.#jellyfin !== null);
    this.#sabnzbdStatus = initialConnectionStatus(this.#sabnzbd !== null);
  }

  /**
   * Starts background work. When enabled it reconciles right away, so a restart can't leave
   * SABnzbd wrongly capped or uncapped.
   */
  start(): void {
    if (this.#lifecycle !== "stopped") {
      return;
    }

    this.#lifecycle = "running";
    this.#log("info", "bandwidth.started", {
      enabled: this.#settings.enabled,
      mode: this.#state.mode,
      ownsLimit: this.#state.ownsLimit,
      restorePending: this.#state.restorePending,
      jellyfinConfigured: this.#jellyfin !== null,
      sabnzbdConfigured: this.#sabnzbd !== null,
    });

    if (this.#settings.enabled) {
      this.#background(this.requestReconcile("startup"));
    } else if (this.#state.restorePending) {
      this.#background(this.#exclusive(() => this.#restorePriorLimit()));
    }
  }

  /** Stops scheduling work and waits for anything in progress to finish. */
  async stop(): Promise<void> {
    if (this.#lifecycle === "running") {
      this.#lifecycle = "stopping";
      this.#clearTimers();
      await this.whenIdle();
      this.#lifecycle = "stopped";
      this.#log("info", "bandwidth.stopped", {});
      return;
    }

    await this.whenIdle();
  }

  /** Resolves once no operation is queued or running, fast-path writes included. */
  async whenIdle(): Promise<void> {
    while (this.#inFlight > 0 || this.#fastPathTasks.size > 0) {
      await Promise.allSettled([this.#chain, ...this.#fastPathTasks]);
    }
  }

  /** "Reconcile now". With automation off it only checks Jellyfin and SABnzbd, changing nothing. */
  reconcileNow(): Promise<ReconcileOutcome> {
    return this.requestReconcile("manual");
  }

  /** Queues a reconcile, or joins the one already waiting to start. */
  requestReconcile(trigger: string): Promise<ReconcileOutcome> {
    if (this.#lifecycle !== "running") {
      return Promise.resolve(this.#skippedOutcome(trigger));
    }

    if (this.#queued) {
      this.#queued.triggers.push(trigger);
      return this.#queued.promise;
    }

    const queued = {
      triggers: [trigger],
      promise: Promise.resolve() as unknown as Promise<ReconcileOutcome>,
    };
    queued.promise = this.#exclusive(() => {
      if (this.#queued === queued) {
        this.#queued = null;
      }
      return this.#runReconcile(queued.triggers);
    });
    this.#queued = queued;
    return queued.promise;
  }

  /**
   * Called for every Jellyfin webhook once its payload parsed. Never throws and never waits: the
   * webhook's own handling goes on unchanged.
   *
   * A playback start or resume that passed the SHARED_SECRET check caps SABnzbd at once (the fast
   * path), then a reconcile checks Jellyfin's sessions. Stops and pauses, and every event when no
   * secret is configured, only trigger that reconcile, which asks Jellyfin before changing
   * anything. Progress pings that change nothing, other events and malformed payloads are
   * ignored, without a log line.
   */
  handleJellyfinWebhook(payload: unknown, context: JellyfinWebhookContext = {}): void {
    try {
      if (this.#lifecycle !== "running" || !this.#settings.enabled) {
        return;
      }

      const receivedAt = context.receivedAt ?? this.#clock.monotonic();
      const event = classifyJellyfinWebhook(payload, this.#knownStreamStates());
      if (!event) {
        return;
      }

      const authenticated = context.authenticated === true && this.#webhookAuthConfigured();
      if (authenticated) {
        this.#noteWebhookStream(event);
      }

      if (authenticated && (event.kind === "start" || event.kind === "resume")) {
        this.#playbackStarted(event, receivedAt);
        return;
      }

      this.#recordWebhook(event.label, "check_requested");
      this.#log("info", "bandwidth.webhook", {
        notification: event.label,
        kind: event.kind,
        authenticated,
        outcome: "check_requested",
      });
      this.#scheduleWebhookReconcile(`webhook:${event.label}`);
    } catch (error) {
      this.#recordError("controller", error);
    }
  }

  /**
   * Saves validated settings. Turning automation on reconciles right away; turning it off puts
   * SABnzbd's prior limit back if SABnzbd still has the one automation set.
   */
  updateSettings(patch: BandwidthSettingsPatch): Promise<BandwidthStatus> {
    return this.#exclusive(async () => {
      const before = this.#settings;
      const after = applySettingsPatch(before, patch, new Date(this.#clock.now()));

      if (after.enabled && !before.enabled && (!this.#jellyfin || !this.#sabnzbd)) {
        throw new BandwidthConfigurationError(
          notConfiguredMessage(this.#jellyfin !== null, this.#sabnzbd !== null),
        );
      }

      this.#store.saveSettings(after);
      this.#settings = after;
      this.#log("info", "bandwidth.settings_saved", describeSettings(after));

      if (before.enabled && !after.enabled) {
        this.#clearTimers();
        this.#resetRuntime();
        this.#log("info", "bandwidth.disabled", {});
        await this.#restorePriorLimit();
      } else if (after.enabled && this.#lifecycle === "running") {
        if (!before.enabled) {
          this.#clearRestoreTimer();
          if (this.#state.restorePending) {
            this.#saveState({ ...this.#state, restorePending: false });
          }
          this.#notice = null;
          this.#log("info", "bandwidth.enabled", {});
        }
        await this.#runReconcile([before.enabled ? "settings" : "enabled"]);
      }

      return this.getStatus();
    });
  }

  getStatus(): BandwidthStatus {
    const now = this.#clock.now();
    const settings = this.#settings;
    const externalChanges = this.#externalChanges.filter((at) =>
      now - at <= externalChangeWindowMs
    );
    const playback = this.#playback;
    const queue = this.#queue;

    return {
      settings: {
        enabled: settings.enabled,
        throttleBytesPerSecond: settings.throttleBytesPerSecond,
        throttleUnit: settings.throttleUnit,
        throttleValue: Number(
          fromBytesPerSecond(settings.throttleBytesPerSecond, settings.throttleUnit).toFixed(3),
        ),
        idlePollIntervalSeconds: settings.idlePollIntervalSeconds,
        activePollIntervalSeconds: settings.activePollIntervalSeconds,
        recoveryGraceSeconds: settings.recoveryGraceSeconds,
        pausedPolicy: settings.pausedPolicy,
        pausedGraceSeconds: settings.pausedGraceSeconds,
        updatedAt: settings.updatedAt,
      },
      configured: { jellyfin: this.#jellyfin !== null, sabnzbd: this.#sabnzbd !== null },
      lifecycle: this.#lifecycle,
      mode: this.#state.mode,
      controllerMode: this.#controllerMode(),
      fastPath: this.#webhookAuthConfigured() ? { enabled: true, reason: null } : {
        enabled: false,
        reason:
          "SHARED_SECRET isn't set, so webhooks can't be trusted to change SABnzbd directly: " +
          "they only trigger a check of Jellyfin's sessions.",
      },
      lastTrigger: this.#lastTrigger
        ? { ...this.#lastTrigger, at: iso(this.#lastTrigger.at) }
        : null,
      lastWebhook: this.#lastWebhook
        ? { ...this.#lastWebhook, at: iso(this.#lastWebhook.at) }
        : null,
      lastWebhookThrottle: this.#lastWebhookThrottle ? { ...this.#lastWebhookThrottle } : null,
      decision: {
        reason: settings.enabled ? this.#decisionReason : "disabled",
        graceUntil: isoOrNull(this.#graceUntil),
        nextCheckAt: isoOrNull(this.#nextCheckAt),
      },
      playback: playback
        ? {
          observedAt: iso(playback.at),
          countedStreams: playback.evaluation.countedStreams,
          playing: playback.evaluation.playing,
          pausedCounted: playback.evaluation.pausedCounted,
          pausedIgnored: playback.evaluation.pausedIgnored,
          stale: playback.evaluation.stale,
          transcoding: playback.evaluation.transcoding,
          totalSessions: playback.evaluation.totalSessions,
          pendingWebhookStreams: this.#pendingWebhookStreams(playback.evaluation, now, false),
          streams: playback.evaluation.sessions.map(({ session, verdict, counted }) => ({
            userName: session.userName,
            client: session.client,
            deviceName: session.deviceName,
            itemName: session.itemName,
            playMethod: session.playMethod,
            isPaused: session.isPaused,
            verdict,
            counted,
          })),
        }
        : null,
      jellyfin: { ...this.#jellyfinStatus },
      sabnzbd: {
        ...this.#sabnzbdStatus,
        observedAt: queue ? iso(queue.at) : null,
        speedLimitBytesPerSecond: queue?.status.speedLimitBytesPerSecond ?? null,
        speedLimitPercent: queue?.status.speedLimitPercent ?? null,
        downloadBytesPerSecond: queue?.status.downloadBytesPerSecond ?? null,
        queueStatus: queue?.status.queueStatus ?? null,
        paused: queue?.status.paused ?? null,
        version: queue?.status.version ?? null,
      },
      lastReconcile: this.#lastReconcile
        ? { ...this.#lastReconcile, at: iso(this.#lastReconcile.at) }
        : null,
      lastSuccessfulReconcileAt: isoOrNull(this.#lastSuccessfulReconcileAt),
      lastChange: this.#state.lastChange,
      ownership: {
        ownsLimit: this.#state.ownsLimit,
        priorLimitBytesPerSecond: this.#state.priorLimitBytesPerSecond,
        appliedLimitBytesPerSecond: this.#state.appliedLimitBytesPerSecond,
        restorePending: this.#state.restorePending,
      },
      conflict: {
        suspected: externalChanges.length >= externalChangeThreshold,
        externalChanges: externalChanges.length,
        windowMinutes: externalChangeWindowMs / 60_000,
        lastAt: isoOrNull(this.#externalChanges.at(-1) ?? null),
      },
      notice: this.#notice ? { at: iso(this.#notice.at), message: this.#notice.message } : null,
      recentErrors: this.#recentErrors.map((entry) => ({
        source: entry.source,
        message: entry.message,
        firstAt: iso(entry.firstAt),
        lastAt: iso(entry.lastAt),
        count: entry.count,
      })),
    };
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    this.#inFlight += 1;
    const result = this.#chain.then(task);
    this.#chain = result.then(noop, noop).then(() => {
      this.#inFlight -= 1;
    });
    return result;
  }

  /** For work nobody awaits. An unhandled rejection would stop the whole server. */
  #background(work: Promise<unknown>): void {
    work.catch((error) => this.#recordError("controller", error));
  }

  async #runReconcile(triggers: string[]): Promise<ReconcileOutcome> {
    const trigger = [...new Set(triggers)].join(", ");

    if (this.#lifecycle !== "running") {
      return this.#skippedOutcome(trigger);
    }

    this.#lastTrigger = { source: triggerSource(triggers), detail: trigger, at: this.#clock.now() };
    // A fast-path write asked for this reconcile (or one queued behind it): time it too.
    const awaiting = this.#awaitingCheck;
    this.#awaitingCheck = null;

    try {
      return this.#settings.enabled ? await this.#reconcile(trigger) : await this.#check(trigger);
    } catch (error) {
      // Only a bug gets here: the steps below handle their own failures.
      this.#recordError("controller", error);
      return this.#finish({
        trigger,
        checkOnly: !this.#settings.enabled,
        success: false,
        mode: null,
        reason: null,
        countedStreams: null,
        change: null,
      });
    } finally {
      if (awaiting) {
        awaiting.timing.receivedToReconcileMs = roundMs(
          this.#clock.monotonic() - awaiting.receivedAt,
        );
      }
      this.#scheduleNextPoll();
    }
  }

  async #reconcile(trigger: string): Promise<ReconcileOutcome> {
    this.#lastReconcileStartedAt = this.#clock.now();
    const settings = this.#settings;
    const jellyfin = this.#jellyfin;
    const sabnzbd = this.#sabnzbd;

    if (!jellyfin || !sabnzbd) {
      // Automation can't be turned on without both, but the environment may have changed since.
      this.#recordError(
        "controller",
        new Error(notConfiguredMessage(jellyfin !== null, sabnzbd !== null)),
      );
      return this.#finish({
        trigger,
        checkOnly: false,
        success: false,
        mode: null,
        reason: null,
        countedStreams: null,
        change: null,
      });
    }

    // A start reported while Jellyfin is being read can't be in its answer: see the lock below.
    const generation = this.#activityGeneration;

    // 1. What is playing: Jellyfin's sessions, plus starts webhooks reported that it doesn't
    //    list yet.
    const evaluation = await this.#observeJellyfin(jellyfin, settings);
    const countedStreams = evaluation === null ? null : evaluation.countedStreams +
      this.#pendingWebhookStreams(evaluation, this.#clock.now(), true);

    // 2 and 3 hold the SABnzbd lock, so a fast-path write can't land between reading SABnzbd's
    // limit and correcting it. SABnzbd is read before deciding, so the decision (and the
    // generation check) come after the last wait and right before any write.
    return await this.#writeLock.run("normal", async () => {
      const queue = await this.#observeSabnzbd(sabnzbd);
      let decision = decideMode({
        previousMode: this.#state.mode,
        countedStreams,
        now: this.#clock.now(),
        inactiveSince: this.#inactiveSince,
        recoveryGraceMs: settings.recoveryGraceSeconds * 1000,
      });

      if (countedStreams === 0 && this.#activityGeneration !== generation) {
        // A playback start arrived after this read began, so the read can't show it: it
        // mustn't start the grace period or lift the cap.
        decision = {
          mode: "throttled",
          reason: "playback_started",
          inactiveSince: null,
          graceUntil: null,
        };
      }

      return await this.#applyDecision(
        trigger,
        settings,
        sabnzbd,
        queue,
        evaluation !== null,
        countedStreams,
        decision,
      );
    });
  }

  /** Steps 2 and 3 of a reconcile: record the decision, then correct SABnzbd if it differs. */
  async #applyDecision(
    trigger: string,
    settings: BandwidthSettings,
    sabnzbd: SabnzbdApi,
    queue: SabnzbdQueueStatus | null,
    jellyfinRead: boolean,
    countedStreams: number | null,
    decision: ModeDecision,
  ): Promise<ReconcileOutcome> {
    // 2. What SABnzbd's limit should be.
    const previous = this.#state;
    this.#inactiveSince = decision.inactiveSince;
    this.#graceUntil = decision.graceUntil;
    this.#decisionReason = decision.reason;

    let next: BandwidthControllerState = { ...previous, mode: decision.mode };
    if (decision.mode !== previous.mode) {
      this.#log("info", "bandwidth.mode_changed", {
        from: previous.mode,
        to: decision.mode,
        reason: decision.reason,
        countedStreams,
      });
    }

    // 3. What SABnzbd has (read just before deciding), and a write only if that differs.
    let applied = queue !== null;
    let change: ReconcileOutcome["change"] = null;

    if (queue) {
      const actual = queue.speedLimitBytesPerSecond;
      const desired = decision.mode === "throttled" ? settings.throttleBytesPerSecond : 0;
      const changedOutside = next.ownsLimit && next.appliedLimitBytesPerSecond !== null &&
        !limitsMatch(actual, next.appliedLimitBytesPerSecond);

      if (changedOutside) {
        this.#noteExternalChange(next.appliedLimitBytesPerSecond ?? 0, actual);
      }

      if (limitsMatch(actual, desired)) {
        if (next.ownsLimit) {
          next = { ...next, appliedLimitBytesPerSecond: desired };
        }
      } else {
        if (!next.ownsLimit) {
          next = {
            ...next,
            ownsLimit: true,
            priorLimitBytesPerSecond: actual,
            appliedLimitBytesPerSecond: null,
          };
        }

        // Kept before writing, so a crash mid-write still knows what to put back.
        this.#saveState(next);

        try {
          await sabnzbd.setSpeedLimit(desired);
          const at = this.#clock.now();
          change = { fromBytesPerSecond: actual, toBytesPerSecond: desired };
          next = {
            ...next,
            appliedLimitBytesPerSecond: desired,
            lastChange: {
              at: iso(at),
              fromBytesPerSecond: actual,
              toBytesPerSecond: desired,
              reason: describeChangeReason(decision.reason, changedOutside),
            },
          };
          this.#queue = { at, status: { ...queue, speedLimitBytesPerSecond: desired } };
          this.#log("info", "bandwidth.limit_changed", {
            trigger,
            from: formatLimit(actual),
            to: formatLimit(desired),
            reason: decision.reason,
            countedStreams,
          });

          if (changedOutside) {
            this.#setNotice(
              `SABnzbd's speed limit was changed outside ObservaRR (to ${
                formatLimit(actual)
              }); set it back to ${formatLimit(desired)}. Turn automation off to set it by hand.`,
            );
          }
        } catch (error) {
          // The limit ObservaRR last set stays on record: SABnzbd most likely still has it.
          applied = false;
          this.#markFailure("sabnzbd", error);
        }
      }
    }

    this.#saveState(next);

    return this.#finish({
      trigger,
      checkOnly: false,
      success: jellyfinRead && queue !== null && applied,
      mode: decision.mode,
      reason: decision.reason,
      countedStreams,
      change,
    });
  }

  /** Automation is off: look, change nothing (other than a restore still owed). */
  async #check(trigger: string): Promise<ReconcileOutcome> {
    this.#lastReconcileStartedAt = this.#clock.now();

    if (this.#state.restorePending) {
      await this.#restorePriorLimit();
    }

    const evaluation = this.#jellyfin
      ? await this.#observeJellyfin(this.#jellyfin, this.#settings)
      : null;
    const queue = this.#sabnzbd ? await this.#observeSabnzbd(this.#sabnzbd) : null;

    return this.#finish({
      trigger,
      checkOnly: true,
      success: evaluation !== null && queue !== null,
      mode: null,
      reason: null,
      countedStreams: evaluation?.countedStreams ?? null,
      change: null,
    });
  }

  async #observeJellyfin(
    jellyfin: JellyfinSessionSource,
    settings: BandwidthSettings,
  ): Promise<PlaybackEvaluation | null> {
    try {
      const snapshot = await jellyfin.fetchSessions();
      const now = this.#clock.now();
      const evaluation = evaluatePlayback(
        snapshot,
        now,
        { pausedPolicy: settings.pausedPolicy, pausedGraceMs: settings.pausedGraceSeconds * 1000 },
        this.#pauseTracker,
      );
      this.#playback = { at: now, evaluation };
      this.#knownStreams = new Map(
        snapshot.playing.map((session) => [sessionStreamKey(session), session.isPaused]),
      );
      this.#markSuccess("jellyfin", now);
      return evaluation;
    } catch (error) {
      this.#markFailure("jellyfin", error);
      return null;
    }
  }

  async #observeSabnzbd(sabnzbd: SabnzbdApi): Promise<SabnzbdQueueStatus | null> {
    try {
      const status = await sabnzbd.getQueueStatus();
      const now = this.#clock.now();
      this.#queue = { at: now, status };
      this.#markSuccess("sabnzbd", now);
      return status;
    } catch (error) {
      this.#markFailure("sabnzbd", error);
      return null;
    }
  }

  /**
   * Puts back the limit SABnzbd had before automation first changed it, if SABnzbd still has the
   * one automation last set. A different limit is someone's deliberate change and stays. Holds
   * the SABnzbd lock, so a playback start that raced turning automation off can't interleave.
   */
  #restorePriorLimit(): Promise<void> {
    return this.#writeLock.run("normal", () => this.#restorePriorLimitLocked());
  }

  async #restorePriorLimitLocked(): Promise<void> {
    const state = this.#state;

    if (!state.ownsLimit) {
      if (state.restorePending || state.mode !== "unrestricted") {
        this.#saveState({ ...state, mode: "unrestricted", restorePending: false });
      }
      return;
    }

    const sabnzbd = this.#sabnzbd;
    if (!sabnzbd) {
      this.#setNotice("SABnzbd is no longer configured, so its previous limit wasn't put back.");
      this.#saveState(releasedState(state));
      return;
    }

    const queue = await this.#observeSabnzbd(sabnzbd);
    if (!queue) {
      this.#keepRestorePending();
      return;
    }

    const actual = queue.speedLimitBytesPerSecond;
    const prior = state.priorLimitBytesPerSecond ?? 0;
    const applied = state.appliedLimitBytesPerSecond;

    if (applied !== null && !limitsMatch(actual, applied)) {
      this.#setNotice(
        `SABnzbd's speed limit was changed outside ObservaRR (it is ${
          formatLimit(actual)
        }; ObservaRR last set ${
          formatLimit(applied)
        }), so it was left as it is rather than put back to ${formatLimit(prior)}.`,
      );
      this.#log("info", "bandwidth.restore_skipped", {
        reason: "changed_outside_observarr",
        current: formatLimit(actual),
        applied: formatLimit(applied),
        prior: formatLimit(prior),
      });
      this.#saveState(releasedState(state));
      return;
    }

    if (limitsMatch(actual, prior)) {
      this.#setNotice(
        `SABnzbd's speed limit is already what it was before automation changed it (${
          formatLimit(prior)
        }).`,
      );
      this.#saveState(releasedState(state));
      return;
    }

    try {
      await sabnzbd.setSpeedLimit(prior);
      const at = this.#clock.now();
      this.#queue = { at, status: { ...queue, speedLimitBytesPerSecond: prior } };
      this.#setNotice(
        `Put SABnzbd's speed limit back to ${
          formatLimit(prior)
        }, what it was before automation changed it.`,
      );
      this.#log("info", "bandwidth.limit_changed", {
        trigger: "disabled",
        from: formatLimit(actual),
        to: formatLimit(prior),
        reason: "restored_prior_limit",
      });
      this.#saveState({
        ...releasedState(state),
        lastChange: {
          at: iso(at),
          fromBytesPerSecond: actual,
          toBytesPerSecond: prior,
          reason: "Automation turned off: the previous limit was put back",
        },
      });
    } catch (error) {
      this.#markFailure("sabnzbd", error);
      this.#keepRestorePending();
    }
  }

  #keepRestorePending(): void {
    if (!this.#state.restorePending) {
      this.#saveState({ ...this.#state, restorePending: true });
    }

    this.#setNotice(
      `Couldn't reach SABnzbd to put its previous speed limit back; retrying every ${
        Math.round(this.#restoreRetryMs / 1000)
      } seconds.`,
    );
    this.#scheduleRestoreRetry(this.#restoreRetryMs);
  }

  #scheduleRestoreRetry(delayMs: number): void {
    this.#clearRestoreTimer();

    if (this.#lifecycle !== "running" || this.#settings.enabled) {
      return;
    }

    this.#restoreTimer = this.#clock.setTimeout(() => {
      this.#restoreTimer = null;
      if (this.#lifecycle !== "running" || this.#settings.enabled || !this.#state.restorePending) {
        return;
      }

      void this.#exclusive(async () => {
        if (!this.#settings.enabled && this.#state.restorePending) {
          await this.#restorePriorLimit();
        }
      }).catch((error) => this.#recordError("controller", error));
    }, delayMs);
  }

  #scheduleWebhookReconcile(trigger: string): void {
    if (this.#queued) {
      // A reconcile that hasn't started yet will see this change.
      this.#queued.triggers.push(trigger);
      return;
    }

    if (this.#webhookTimer !== null) {
      return;
    }

    const now = this.#clock.now();
    const readyAt = this.#lastReconcileStartedAt + this.#webhookMinIntervalMs;

    if (now >= readyAt) {
      this.#background(this.requestReconcile(trigger));
      return;
    }

    this.#webhookTimer = this.#clock.setTimeout(() => {
      this.#webhookTimer = null;
      this.#background(this.requestReconcile(trigger));
    }, readyAt - now);
  }

  /**
   * The next poll. Polling is the safety net, so it is adaptive: the active interval while
   * capped (webhooks report playback ending, polls only catch a missed one), the idle interval
   * while unrestricted and while the last check failed (Jellyfin unreadable, SABnzbd not
   * answering). Sooner when the grace period ends, a paused or stale stream stops counting, or a
   * webhook-reported start Jellyfin never listed runs out.
   */
  #scheduleNextPoll(): void {
    this.#clearPollTimer();

    if (this.#lifecycle !== "running" || !this.#settings.enabled) {
      return;
    }

    const now = this.#clock.now();
    const failing = this.#decisionReason === "jellyfin_unavailable" ||
      this.#lastReconcile?.success === false;
    const intervalSeconds = this.#state.mode === "throttled" && !failing
      ? this.#settings.activePollIntervalSeconds
      : this.#settings.idlePollIntervalSeconds;
    let delay = intervalSeconds * 1000;

    for (
      const at of [
        this.#graceUntil,
        this.#playback?.evaluation.nextChangeAt ?? null,
        this.#nextEvidenceExpiry(),
      ]
    ) {
      if (at !== null && at > now) {
        delay = Math.min(delay, at - now);
      }
    }

    delay = Math.max(delay, minimumPollDelayMs);
    this.#nextCheckAt = now + delay;
    this.#pollTimer = this.#clock.setTimeout(() => {
      this.#pollTimer = null;
      this.#background(this.requestReconcile("poll"));
    }, delay);
  }

  #clearPollTimer(): void {
    if (this.#pollTimer !== null) {
      this.#clock.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#nextCheckAt = null;
  }

  #clearRestoreTimer(): void {
    if (this.#restoreTimer !== null) {
      this.#clock.clearTimeout(this.#restoreTimer);
      this.#restoreTimer = null;
    }
  }

  #clearTimers(): void {
    this.#clearPollTimer();
    this.#clearRestoreTimer();

    if (this.#webhookTimer !== null) {
      this.#clock.clearTimeout(this.#webhookTimer);
      this.#webhookTimer = null;
    }
  }

  #resetRuntime(): void {
    this.#inactiveSince = null;
    this.#graceUntil = null;
    this.#decisionReason = null;
    this.#pauseTracker.clear();
    this.#webhookStreams.clear();
    this.#awaitingCheck = null;
  }

  /** Stream key -> IsPaused: the last Jellyfin check, updated by webhooks since. */
  #knownStreamStates(): Map<string, boolean> {
    const known = new Map(this.#knownStreams ?? []);
    for (const [key, entry] of this.#webhookStreams) {
      known.set(key, entry.paused);
    }
    return known;
  }

  /** Remembers what an authenticated webhook said about a stream. */
  #noteWebhookStream(event: PlaybackWebhook): void {
    if (event.kind === "stop") {
      this.#webhookStreams.delete(event.streamKey);
    } else {
      this.#webhookStreams.set(event.streamKey, {
        at: this.#clock.now(),
        paused: event.kind === "pause",
      });
    }
  }

  /**
   * Webhook-reported streams Jellyfin's sessions don't list (yet) and that aren't paused, within
   * the evidence window: each counts as a stream. With `prune`, entries Jellyfin now lists, or
   * whose window passed, are dropped: from then on Jellyfin's sessions alone decide.
   */
  #pendingWebhookStreams(evaluation: PlaybackEvaluation, now: number, prune: boolean): number {
    const listed = new Set(evaluation.sessions.map(({ session }) => sessionStreamKey(session)));
    let pending = 0;

    for (const [key, entry] of this.#webhookStreams) {
      if (listed.has(key) || now - entry.at >= this.#webhookEvidenceMs) {
        if (prune) {
          this.#webhookStreams.delete(key);
        }
        continue;
      }

      if (!entry.paused) {
        pending += 1;
      }
    }

    return pending;
  }

  /** When the soonest webhook-reported start stops counting unless Jellyfin lists it. */
  #nextEvidenceExpiry(): number | null {
    let soonest: number | null = null;
    for (const entry of this.#webhookStreams.values()) {
      if (!entry.paused) {
        const at = entry.at + this.#webhookEvidenceMs;
        soonest = soonest === null ? at : Math.min(soonest, at);
      }
    }
    return soonest;
  }

  /** The fast path: playback started or resumed, according to an authenticated webhook. */
  #playbackStarted(event: PlaybackWebhook, receivedAt: number): void {
    this.#activityGeneration += 1;
    // Playback is back, so no grace period is counting down any more.
    this.#inactiveSince = null;
    this.#graceUntil = null;
    this.#decisionReason = "playback_started";
    this.#lastTrigger = { source: "webhook", detail: event.label, at: this.#clock.now() };

    const task: Promise<void> = this.#throttleNow(event, receivedAt)
      .catch((error) => this.#recordError("controller", error))
      .finally(() => this.#fastPathTasks.delete(task));
    this.#fastPathTasks.add(task);
  }

  /**
   * Writes the cap now, ahead of any queued reconcile: no Jellyfin request, and no SABnzbd read
   * either, unless SABnzbd hasn't answered since startup and automation doesn't own its limit
   * yet (then one read, to know which limit to put back when automation is turned off).
   * Duplicate starts write nothing. A reconcile then checks Jellyfin's sessions; it can't lift
   * the cap this start set (see #reconcile).
   */
  async #throttleNow(event: PlaybackWebhook, receivedAt: number): Promise<void> {
    const sabnzbd = this.#sabnzbd;
    const outcome = await this.#writeLock.run("high", async (): Promise<WebhookOutcome | null> => {
      if (this.#lifecycle !== "running" || !this.#settings.enabled || !sabnzbd) {
        return null;
      }

      const desired = this.#settings.throttleBytesPerSecond;
      let state: BandwidthControllerState = { ...this.#state, mode: "throttled" };
      let current = state.ownsLimit
        ? state.appliedLimitBytesPerSecond
        : this.#queue?.status.speedLimitBytesPerSecond ?? null;

      if (!state.ownsLimit && current === null) {
        current = (await this.#observeSabnzbd(sabnzbd))?.speedLimitBytesPerSecond ?? null;
      }

      if (current !== null && limitsMatch(current, desired)) {
        this.#saveState(state);
        return "already_capped";
      }

      if (!state.ownsLimit) {
        state = {
          ...state,
          ownsLimit: true,
          priorLimitBytesPerSecond: current,
          appliedLimitBytesPerSecond: null,
        };
      }

      // Kept before writing, so a crash mid-write still knows what to put back.
      this.#saveState(state);

      const requestAt = this.#clock.monotonic();
      const timing: WebhookThrottleTiming = {
        event: event.label,
        receivedAt: iso(this.#clock.now() - (requestAt - receivedAt)),
        outcome: "cap_failed",
        receivedToRequestMs: roundMs(requestAt - receivedAt),
        requestMs: null,
        receivedToAckMs: null,
        receivedToReconcileMs: null,
      };
      this.#lastWebhookThrottle = timing;
      this.#awaitingCheck = { timing, receivedAt };

      try {
        await sabnzbd.setSpeedLimit(desired);
      } catch (error) {
        // Nothing on record changes: the follow-up reconcile and the polls retry the write.
        this.#markFailure("sabnzbd", error);
        return "cap_failed";
      }

      const ackAt = this.#clock.monotonic();
      timing.outcome = "capped";
      timing.requestMs = roundMs(ackAt - requestAt);
      timing.receivedToAckMs = roundMs(ackAt - receivedAt);
      const at = this.#clock.now();
      this.#saveState({
        ...state,
        appliedLimitBytesPerSecond: desired,
        lastChange: {
          at: iso(at),
          fromBytesPerSecond: current,
          toBytesPerSecond: desired,
          reason: describeChangeReason("playback_started", false),
        },
      });
      if (this.#queue) {
        this.#queue = { at, status: { ...this.#queue.status, speedLimitBytesPerSecond: desired } };
      }
      this.#markSuccess("sabnzbd", at);
      this.#log("info", "bandwidth.limit_changed", {
        trigger: `webhook:${event.label}`,
        from: formatLimit(current),
        to: formatLimit(desired),
        reason: "playback_started",
        receivedToAckMs: timing.receivedToAckMs,
      });
      return "capped";
    });

    if (outcome === null) {
      return;
    }

    this.#recordWebhook(event.label, outcome);
    if (!this.#settings.enabled) {
      return; // turned off while the cap was being written; the restore took it from there
    }
    const timing = this.#lastWebhookThrottle;
    this.#log(outcome === "cap_failed" ? "warn" : "info", "bandwidth.webhook", {
      notification: event.label,
      kind: event.kind,
      authenticated: true,
      outcome,
      ...(outcome === "already_capped" || !timing ? {} : {
        receivedToRequestMs: timing.receivedToRequestMs,
        requestMs: timing.requestMs,
        receivedToAckMs: timing.receivedToAckMs,
      }),
    });
    this.#scheduleWebhookReconcile(`webhook:${event.label}`);
  }

  #recordWebhook(event: string, outcome: WebhookOutcome): void {
    this.#lastWebhook = { event, outcome, at: this.#clock.now() };
  }

  #controllerMode(): ControllerMode {
    if (!this.#settings.enabled) {
      return "off";
    }
    if (this.#state.mode === "unrestricted") {
      return "unrestricted";
    }
    if (this.#decisionReason === "grace_period") {
      return "recovery_grace";
    }
    if (this.#decisionReason === "jellyfin_unavailable") {
      return "protective_error";
    }
    return "throttled";
  }

  #saveState(next: BandwidthControllerState): void {
    if (JSON.stringify(next) === JSON.stringify(this.#state)) {
      return;
    }

    this.#store.saveState(next);
    this.#state = next;
  }

  #noteExternalChange(expected: number, found: number): void {
    const now = this.#clock.now();
    this.#externalChanges = [
      ...this.#externalChanges.filter((at) => now - at <= externalChangeWindowMs),
      now,
    ];
    this.#log("warn", "bandwidth.external_change", {
      expected: formatLimit(expected),
      found: formatLimit(found),
      recentChanges: this.#externalChanges.length,
    });

    if (this.#externalChanges.length >= externalChangeThreshold) {
      if (!this.#conflictLogged) {
        this.#conflictLogged = true;
        this.#log("warn", "bandwidth.conflict_suspected", {
          recentChanges: this.#externalChanges.length,
          windowMinutes: externalChangeWindowMs / 60_000,
        });
      }
    } else {
      this.#conflictLogged = false;
    }
  }

  #markSuccess(source: "jellyfin" | "sabnzbd", now: number): void {
    const status = source === "jellyfin" ? this.#jellyfinStatus : this.#sabnzbdStatus;

    if (status.state === "error") {
      this.#log("info", `bandwidth.${source}_recovered`, { since: status.lastErrorAt });
    }

    status.state = "ok";
    status.lastSuccessAt = iso(now);
  }

  #markFailure(source: "jellyfin" | "sabnzbd", error: unknown): void {
    const status = source === "jellyfin" ? this.#jellyfinStatus : this.#sabnzbdStatus;
    const message = this.#safeMessage(error);

    if (status.state !== "error" || status.lastError !== message) {
      this.#log("warn", `bandwidth.${source}_failed`, { error: message });
    }

    status.state = "error";
    status.lastErrorAt = iso(this.#clock.now());
    status.lastError = message;
    this.#pushError(source, message);
  }

  #recordError(source: ErrorSource, error: unknown): void {
    const message = this.#safeMessage(error);
    this.#log("error", "bandwidth.error", { source, error: message });
    this.#pushError(source, message);
  }

  #pushError(source: ErrorSource, message: string): void {
    const now = this.#clock.now();
    const index = this.#recentErrors.findIndex((entry) =>
      entry.source === source && entry.message === message
    );

    if (index >= 0) {
      const [entry] = this.#recentErrors.splice(index, 1);
      entry.lastAt = now;
      entry.count += 1;
      this.#recentErrors.unshift(entry);
      return;
    }

    this.#recentErrors.unshift({ source, message, firstAt: now, lastAt: now, count: 1 });
    this.#recentErrors.length = Math.min(this.#recentErrors.length, maxRecentErrors);
  }

  #safeMessage(error: unknown): string {
    const text = error instanceof UpstreamRequestError || error instanceof Error
      ? error.message
      : String(error);
    return redactSecrets(text, this.#secrets).slice(0, 300) || "Unknown error";
  }

  #setNotice(message: string): void {
    this.#notice = { at: this.#clock.now(), message };
  }

  #finish(input: {
    trigger: string;
    checkOnly: boolean;
    success: boolean;
    mode: BandwidthMode | null;
    reason: DecisionReason | null;
    countedStreams: number | null;
    change: ReconcileOutcome["change"];
  }): ReconcileOutcome {
    const finishedAt = this.#clock.now();
    this.#lastReconcile = {
      at: finishedAt,
      trigger: input.trigger,
      success: input.success,
      checkOnly: input.checkOnly,
    };

    if (input.success && !input.checkOnly) {
      this.#lastSuccessfulReconcileAt = finishedAt;
    }

    return {
      trigger: input.trigger,
      at: iso(finishedAt),
      checkOnly: input.checkOnly,
      success: input.success,
      mode: input.mode,
      reason: input.reason,
      countedStreams: input.countedStreams,
      change: input.change,
      skipped: null,
    };
  }

  #skippedOutcome(trigger: string): ReconcileOutcome {
    return {
      trigger,
      at: iso(this.#clock.now()),
      checkOnly: !this.#settings.enabled,
      success: false,
      mode: null,
      reason: null,
      countedStreams: null,
      change: null,
      skipped: "stopped",
    };
  }
}

export function notConfiguredMessage(
  jellyfinConfigured: boolean,
  sabnzbdConfigured: boolean,
): string {
  const missing = [
    ...(jellyfinConfigured ? [] : ["JELLYFIN_URL and JELLYFIN_API_KEY"]),
    ...(sabnzbdConfigured ? [] : ["SABNZBD_URL and SABNZBD_API_KEY"]),
  ];
  return `Bandwidth automation needs ${missing.join(" and ")} set in the container's environment.`;
}

function releasedState(state: BandwidthControllerState): BandwidthControllerState {
  return {
    ...state,
    mode: "unrestricted",
    ownsLimit: false,
    priorLimitBytesPerSecond: null,
    appliedLimitBytesPerSecond: null,
    restorePending: false,
  };
}

function describeChangeReason(reason: DecisionReason, changedOutside: boolean): string {
  const base = {
    streams_active: "Jellyfin playback: cap applied",
    playback_started: "Jellyfin playback started (webhook): cap applied",
    grace_period: "Recovery grace period: cap kept",
    idle: "No Jellyfin playback: cap removed",
    jellyfin_unavailable: "Jellyfin unreachable: protective cap applied",
  }[reason];
  return changedOutside ? `${base} (it had been changed outside ObservaRR)` : base;
}

function describeSettings(settings: BandwidthSettings): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    throttle: formatLimit(settings.throttleBytesPerSecond),
    idlePollIntervalSeconds: settings.idlePollIntervalSeconds,
    activePollIntervalSeconds: settings.activePollIntervalSeconds,
    recoveryGraceSeconds: settings.recoveryGraceSeconds,
    pausedPolicy: settings.pausedPolicy,
    pausedGraceSeconds: settings.pausedGraceSeconds,
  };
}

/** What started a reconcile, for the dashboard; a shared run counts as its most telling cause. */
function triggerSource(triggers: readonly string[]): TriggerSource {
  if (triggers.includes("manual")) return "manual";
  if (triggers.some((trigger) => trigger.startsWith("webhook"))) return "webhook";
  if (triggers.includes("startup")) return "startup";
  if (triggers.includes("settings") || triggers.includes("enabled")) return "settings";
  return "poll";
}

/** Milliseconds to 0.1 ms. */
function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function initialConnectionStatus(configured: boolean): ConnectionStatus {
  return {
    state: configured ? "unknown" : "not_configured",
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}

function noop(): void {}
