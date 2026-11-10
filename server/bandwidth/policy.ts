import type {
  JellyfinPlaybackSession,
  JellyfinSessionsSnapshot,
} from "../integrations/jellyfin/sessions.ts";
import type { BandwidthMode, PausedPolicy } from "./settings.ts";

/**
 * A playing session that has not checked in for this long is stale and no longer counts. It is
 * the same threshold Jellyfin uses to stop idle playback itself; clients check in about every 10
 * seconds, paused or not.
 */
export const staleSessionMs = 5 * 60_000;

export type SessionVerdict = "playing" | "paused_counted" | "paused_ignored" | "stale";

export type EvaluatedSession = {
  session: JellyfinPlaybackSession;
  verdict: SessionVerdict;
  counted: boolean;
};

export type PlaybackEvaluation = {
  /** Streams that keep the cap on. */
  countedStreams: number;
  playing: number;
  pausedCounted: number;
  pausedIgnored: number;
  stale: number;
  /** Counted streams Jellyfin is transcoding. */
  transcoding: number;
  /** Every session Jellyfin reported, including ones that are only connected. */
  totalSessions: number;
  /** The soonest a counted stream stops counting (paused grace or staleness), epoch ms. */
  nextChangeAt: number | null;
  sessions: EvaluatedSession[];
};

/**
 * When each paused session was first seen paused, for Jellyfin versions without LastPausedDate.
 * In memory only: after a restart the paused grace starts over, which errs toward keeping the cap.
 */
export class PauseTracker {
  #pausedSince = new Map<string, number>();

  update(sessions: readonly JellyfinPlaybackSession[], now: number): void {
    const paused = new Set<string>();

    for (const session of sessions) {
      if (!session.isPaused) {
        continue;
      }

      const key = pauseKey(session);
      paused.add(key);
      if (!this.#pausedSince.has(key)) {
        this.#pausedSince.set(key, now);
      }
    }

    for (const key of [...this.#pausedSince.keys()]) {
      if (!paused.has(key)) {
        this.#pausedSince.delete(key);
      }
    }
  }

  pausedSince(session: JellyfinPlaybackSession): number | null {
    return this.#pausedSince.get(pauseKey(session)) ?? null;
  }

  clear(): void {
    this.#pausedSince.clear();
  }
}

function pauseKey(session: JellyfinPlaybackSession): string {
  return `${session.id}\u0000${session.itemId ?? ""}`;
}

/**
 * Which of Jellyfin's sessions keep the cap on. Every user's playback counts, direct play and
 * transcodes alike; connected sessions with nothing playing were already left out.
 */
export function evaluatePlayback(
  snapshot: JellyfinSessionsSnapshot,
  now: number,
  policy: { pausedPolicy: PausedPolicy; pausedGraceMs: number },
  tracker: PauseTracker,
): PlaybackEvaluation {
  tracker.update(snapshot.playing, now);

  const evaluation: PlaybackEvaluation = {
    countedStreams: 0,
    playing: 0,
    pausedCounted: 0,
    pausedIgnored: 0,
    stale: 0,
    transcoding: 0,
    totalSessions: snapshot.totalSessions,
    nextChangeAt: null,
    sessions: [],
  };

  const soonest = (at: number) => {
    evaluation.nextChangeAt = evaluation.nextChangeAt === null
      ? at
      : Math.min(evaluation.nextChangeAt, at);
  };

  for (const session of snapshot.playing) {
    // Unknown activity times count as fresh: when in doubt, keep the cap.
    const staleAt = session.lastSeenAt === null ? null : session.lastSeenAt + staleSessionMs;
    let verdict: SessionVerdict;

    if (staleAt !== null && now >= staleAt) {
      verdict = "stale";
    } else if (!session.isPaused) {
      verdict = "playing";
    } else if (policy.pausedPolicy === "active") {
      verdict = "paused_counted";
    } else if (policy.pausedPolicy === "idle") {
      verdict = "paused_ignored";
    } else {
      const pausedSince = session.pausedAt ?? tracker.pausedSince(session) ?? now;
      const countsUntil = pausedSince + policy.pausedGraceMs;
      verdict = now < countsUntil ? "paused_counted" : "paused_ignored";
      if (verdict === "paused_counted") {
        soonest(countsUntil);
      }
    }

    const counted = verdict === "playing" || verdict === "paused_counted";
    if (counted) {
      evaluation.countedStreams += 1;
      if (staleAt !== null) {
        soonest(staleAt);
      }
      if (session.playMethod?.toLowerCase() === "transcode") {
        evaluation.transcoding += 1;
      }
    }

    if (verdict === "playing") evaluation.playing += 1;
    if (verdict === "paused_counted") evaluation.pausedCounted += 1;
    if (verdict === "paused_ignored") evaluation.pausedIgnored += 1;
    if (verdict === "stale") evaluation.stale += 1;

    evaluation.sessions.push({ session, verdict, counted });
  }

  return evaluation;
}

export type DecisionReason =
  | "streams_active"
  | "grace_period"
  | "idle"
  | "jellyfin_unavailable";

export type ModeDecision = {
  mode: BandwidthMode;
  reason: DecisionReason;
  /** Since when no stream has counted, while that lasts. */
  inactiveSince: number | null;
  /** When the cap comes off if nothing starts playing first. */
  graceUntil: number | null;
};

/**
 * Throttled while anything counts; unrestricted once nothing has counted for the recovery grace.
 * When Jellyfin can't be read (`countedStreams` null) the cap goes on or stays on: an unreadable
 * Jellyfin must never lift it.
 */
export function decideMode(input: {
  previousMode: BandwidthMode;
  countedStreams: number | null;
  now: number;
  inactiveSince: number | null;
  recoveryGraceMs: number;
}): ModeDecision {
  if (input.countedStreams === null) {
    return {
      mode: "throttled",
      reason: "jellyfin_unavailable",
      inactiveSince: null,
      graceUntil: null,
    };
  }

  if (input.countedStreams > 0) {
    return { mode: "throttled", reason: "streams_active", inactiveSince: null, graceUntil: null };
  }

  const inactiveSince = input.inactiveSince ?? input.now;

  if (input.previousMode === "unrestricted") {
    return { mode: "unrestricted", reason: "idle", inactiveSince, graceUntil: null };
  }

  const graceUntil = inactiveSince + input.recoveryGraceMs;
  if (input.now >= graceUntil) {
    return { mode: "unrestricted", reason: "idle", inactiveSince, graceUntil: null };
  }

  return { mode: "throttled", reason: "grace_period", inactiveSince, graceUntil };
}

/**
 * Whether SABnzbd's limit already is the wanted one. No limit means exactly 0: a limit equal to
 * SABnzbd's line speed (its "100%") still counts as a limit and is cleared once. Otherwise a
 * small tolerance absorbs rounding.
 */
export function limitsMatch(actualBytesPerSecond: number, desiredBytesPerSecond: number): boolean {
  if (desiredBytesPerSecond <= 0 || actualBytesPerSecond <= 0) {
    return desiredBytesPerSecond <= 0 && actualBytesPerSecond <= 0;
  }

  const tolerance = Math.max(1024, desiredBytesPerSecond * 0.005);
  return Math.abs(actualBytesPerSecond - desiredBytesPerSecond) <= tolerance;
}

/**
 * Whether a Jellyfin webhook is worth reconciling for right away, and why. Starts and stops
 * always are. Progress pings arrive every few seconds per stream, so only a stream the last
 * check didn't know about, or one that paused or resumed since, counts. `knownStreams` maps
 * DeviceId to IsPaused from the last successful check; null means there wasn't one.
 */
export function webhookTriggerReason(
  payload: unknown,
  knownStreams: ReadonlyMap<string, boolean> | null,
): string | null {
  if (!isObject(payload)) {
    return null;
  }

  const type = pickString(payload, ["NotificationType", "notificationType", "Event", "event"]);

  if (type === "PlaybackStart" || type === "PlaybackStop") {
    return type;
  }

  if (type !== "PlaybackProgress") {
    return null;
  }

  const deviceId = pickString(payload, ["DeviceId", "deviceId"]);
  if (!deviceId || !knownStreams) {
    return "PlaybackProgress";
  }

  const knownPaused = knownStreams.get(deviceId);
  if (knownPaused === undefined) {
    return "PlaybackProgress (new stream)";
  }

  const isPaused = typeof payload.IsPaused === "boolean" ? payload.IsPaused : null;
  if (isPaused !== null && isPaused !== knownPaused) {
    return isPaused ? "PlaybackProgress (paused)" : "PlaybackProgress (resumed)";
  }

  return null;
}

function pickString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
