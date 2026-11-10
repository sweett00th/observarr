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
  /** An authenticated webhook reported playback; Jellyfin's sessions haven't confirmed it yet. */
  | "playback_started"
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

/** What a Jellyfin playback webhook means here. Starts and resumes cap at once; the rest check. */
export type PlaybackEventKind = "start" | "resume" | "pause" | "stop";

export type PlaybackWebhook = {
  kind: PlaybackEventKind;
  /** The stream it is about: see playbackStreamKey. */
  streamKey: string;
  /** For logs and the status, e.g. "PlaybackStart" or "PlaybackProgress (resumed)". */
  label: string;
};

/**
 * What a Jellyfin Webhook plugin payload means for bandwidth automation, or null when nothing.
 *
 * The plugin sends PlaybackStart, PlaybackProgress and PlaybackStop; it has no pause or resume
 * event. Pauses and resumes are progress events whose IsPaused differs from what was last known
 * for that stream (`known` maps stream keys to IsPaused). Progress pings arrive every few seconds
 * per stream, so one that changes nothing is null, as are other notification types and payloads
 * missing the fields every plugin playback event carries (ItemId; IsPaused for progress).
 */
export function classifyJellyfinWebhook(
  payload: unknown,
  known: ReadonlyMap<string, boolean>,
): PlaybackWebhook | null {
  if (!isObject(payload)) {
    return null;
  }

  const type = pickString(payload, ["NotificationType", "notificationType"]);
  if (type !== "PlaybackStart" && type !== "PlaybackProgress" && type !== "PlaybackStop") {
    return null;
  }

  const streamKey = playbackStreamKey(payload);
  if (!streamKey) {
    return null;
  }

  if (type === "PlaybackStart") {
    return { kind: "start", streamKey, label: type };
  }

  if (type === "PlaybackStop") {
    return { kind: "stop", streamKey, label: type };
  }

  const isPaused = typeof payload.IsPaused === "boolean" ? payload.IsPaused : null;
  if (isPaused === null) {
    return null;
  }

  const knownPaused = known.get(streamKey);
  if (knownPaused === isPaused) {
    return null;
  }

  if (knownPaused === undefined) {
    return isPaused
      ? { kind: "pause", streamKey, label: "PlaybackProgress (paused, new stream)" }
      : { kind: "resume", streamKey, label: "PlaybackProgress (new stream)" };
  }

  return isPaused
    ? { kind: "pause", streamKey, label: "PlaybackProgress (paused)" }
    : { kind: "resume", streamKey, label: "PlaybackProgress (resumed)" };
}

/**
 * Names the stream a webhook payload is about, the way sessionStreamKey names a /Sessions entry:
 * Jellyfin's DeviceId, else its session Id, else user and item. Null without an ItemId, which every
 * playback event from the plugin has.
 */
export function playbackStreamKey(payload: Record<string, unknown>): string | null {
  const itemId = pickString(payload, ["ItemId", "itemId"]);
  if (!itemId) {
    return null;
  }

  const deviceId = pickString(payload, ["DeviceId", "deviceId"]);
  if (deviceId) {
    return deviceId;
  }

  const sessionId = pickString(payload, ["Id", "SessionId"]);
  if (sessionId) {
    return `session:${sessionId}`;
  }

  return `user:${pickString(payload, ["UserId", "NotificationUsername"]) ?? ""}:${itemId}`;
}

/** The key webhooks use for this session's stream; see playbackStreamKey. */
export function sessionStreamKey(session: JellyfinPlaybackSession): string {
  return session.deviceId ?? `session:${session.id}`;
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
