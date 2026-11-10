import type { DB } from "sqlite";
import {
  fromBytesPerSecond,
  isThrottleUnit,
  type ThrottleUnit,
  toBytesPerSecond,
} from "./units.ts";

/**
 * What a paused stream counts as: "grace" counts it for pausedGraceSeconds after it pauses,
 * "active" always counts it (the cap stays while anything is paused), "idle" never does.
 */
export type PausedPolicy = "grace" | "active" | "idle";

export const pausedPolicies: readonly PausedPolicy[] = ["grace", "active", "idle"];

/** Nonsecret settings, kept in SQLite. URLs and API keys come from the environment only. */
export type BandwidthSettings = {
  enabled: boolean;
  /** The cap while anything plays, in bytes/s. */
  throttleBytesPerSecond: number;
  /** The unit the cap was entered in, for showing it back the same way. */
  throttleUnit: ThrottleUnit;
  pollIntervalSeconds: number;
  /** How long no stream must be playing before the cap comes off. */
  recoveryGraceSeconds: number;
  pausedPolicy: PausedPolicy;
  pausedGraceSeconds: number;
  updatedAt: string | null;
};

export const defaultBandwidthSettings: BandwidthSettings = {
  enabled: false,
  throttleBytesPerSecond: 10_000_000, // 80 Mb/s = 10 MB/s
  throttleUnit: "Mbps",
  pollIntervalSeconds: 5,
  recoveryGraceSeconds: 30,
  pausedPolicy: "grace",
  pausedGraceSeconds: 120,
  updatedAt: null,
};

export const bandwidthSettingLimits = {
  /** The cap, in Mb/s: 1 Mb/s (125 kB/s) to 10,000 Mb/s (1.25 GB/s). */
  throttleMbps: { min: 1, max: 10_000 },
  pollIntervalSeconds: { min: 2, max: 300 },
  recoveryGraceSeconds: { min: 0, max: 3600 },
  pausedGraceSeconds: { min: 0, max: 3600 },
} as const;

export type BandwidthMode = "unrestricted" | "throttled";

/**
 * The controller's own bookkeeping, kept in SQLite so a restart picks up where it left off.
 * `priorLimitBytesPerSecond` is SABnzbd's limit from before ObservaRR first changed it, put back
 * when automation is turned off, but only while SABnzbd still has the limit ObservaRR last set
 * (`appliedLimitBytesPerSecond`); anything else is someone's deliberate change and is left alone.
 * Limits are bytes/s, 0 meaning none.
 */
export type BandwidthControllerState = {
  mode: BandwidthMode;
  ownsLimit: boolean;
  priorLimitBytesPerSecond: number | null;
  appliedLimitBytesPerSecond: number | null;
  /** Turning automation off couldn't put the prior limit back yet; it is retried. */
  restorePending: boolean;
  lastChange: BandwidthLimitChange | null;
};

export type BandwidthLimitChange = {
  at: string;
  fromBytesPerSecond: number | null;
  toBytesPerSecond: number;
  reason: string;
};

export const initialControllerState: BandwidthControllerState = {
  mode: "unrestricted",
  ownsLimit: false,
  priorLimitBytesPerSecond: null,
  appliedLimitBytesPerSecond: null,
  restorePending: false,
  lastChange: null,
};

export type BandwidthSettingsPatch = {
  enabled?: boolean;
  throttle?: { value: number; unit: ThrottleUnit };
  pollIntervalSeconds?: number;
  recoveryGraceSeconds?: number;
  pausedPolicy?: PausedPolicy;
  pausedGraceSeconds?: number;
};

const patchKeys = new Set([
  "enabled",
  "throttle",
  "pollIntervalSeconds",
  "recoveryGraceSeconds",
  "pausedPolicy",
  "pausedGraceSeconds",
]);

/** Validates a settings change from the API. Unknown fields are rejected, not ignored. */
export function parseSettingsPatch(
  input: unknown,
): { ok: true; patch: BandwidthSettingsPatch } | { ok: false; error: string } {
  if (!isObject(input)) {
    return { ok: false, error: "Expected a JSON object" };
  }

  const unknown = Object.keys(input).filter((key) => !patchKeys.has(key));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown setting: ${unknown.join(", ")}` };
  }

  const patch: BandwidthSettingsPatch = {};

  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") {
      return { ok: false, error: "enabled must be true or false" };
    }
    patch.enabled = input.enabled;
  }

  if ("throttle" in input) {
    const throttle = input.throttle;
    if (!isObject(throttle) || !isThrottleUnit(throttle.unit)) {
      return {
        ok: false,
        error: 'throttle must be {"value": number, "unit": "Mbps" or "MBps"}',
      };
    }

    const value = throttle.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: "throttle.value must be a number" };
    }

    const mbps = fromBytesPerSecond(toBytesPerSecond(value, throttle.unit), "Mbps");
    const { min, max } = bandwidthSettingLimits.throttleMbps;
    if (mbps < min || mbps > max) {
      return {
        ok: false,
        error: `The throttled speed must be between ${min} and ${max} Mb/s (${min / 8} to ${
          max / 8
        } MB/s)`,
      };
    }

    patch.throttle = { value, unit: throttle.unit };
  }

  for (
    const key of ["pollIntervalSeconds", "recoveryGraceSeconds", "pausedGraceSeconds"] as const
  ) {
    if (key in input) {
      const value = input[key];
      const { min, max } = bandwidthSettingLimits[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return { ok: false, error: `${key} must be a whole number from ${min} to ${max}` };
      }
      patch[key] = value;
    }
  }

  if ("pausedPolicy" in input) {
    if (!pausedPolicies.includes(input.pausedPolicy as PausedPolicy)) {
      return { ok: false, error: `pausedPolicy must be one of ${pausedPolicies.join(", ")}` };
    }
    patch.pausedPolicy = input.pausedPolicy as PausedPolicy;
  }

  return { ok: true, patch };
}

export function applySettingsPatch(
  settings: BandwidthSettings,
  patch: BandwidthSettingsPatch,
  now: Date,
): BandwidthSettings {
  return {
    enabled: patch.enabled ?? settings.enabled,
    throttleBytesPerSecond: patch.throttle
      ? toBytesPerSecond(patch.throttle.value, patch.throttle.unit)
      : settings.throttleBytesPerSecond,
    throttleUnit: patch.throttle?.unit ?? settings.throttleUnit,
    pollIntervalSeconds: patch.pollIntervalSeconds ?? settings.pollIntervalSeconds,
    recoveryGraceSeconds: patch.recoveryGraceSeconds ?? settings.recoveryGraceSeconds,
    pausedPolicy: patch.pausedPolicy ?? settings.pausedPolicy,
    pausedGraceSeconds: patch.pausedGraceSeconds ?? settings.pausedGraceSeconds,
    updatedAt: now.toISOString(),
  };
}

export interface BandwidthStore {
  getSettings(): BandwidthSettings;
  saveSettings(settings: BandwidthSettings): void;
  getState(): BandwidthControllerState;
  saveState(state: BandwidthControllerState): void;
}

/** Single-row tables created by migration 11. */
export class SqliteBandwidthStore implements BandwidthStore {
  readonly #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  getSettings(): BandwidthSettings {
    const row = firstRow(
      this.#db,
      `SELECT enabled, throttle_bytes_per_second, throttle_unit, poll_interval_seconds,
        recovery_grace_seconds, paused_policy, paused_grace_seconds, updated_at
      FROM bandwidth_automation_settings WHERE id = 1`,
    );

    if (!row) {
      return { ...defaultBandwidthSettings };
    }

    const defaults = defaultBandwidthSettings;
    return {
      enabled: Number(row[0]) === 1,
      throttleBytesPerSecond: positiveInteger(row[1]) ?? defaults.throttleBytesPerSecond,
      throttleUnit: isThrottleUnit(row[2]) ? row[2] : defaults.throttleUnit,
      pollIntervalSeconds: positiveInteger(row[3]) ?? defaults.pollIntervalSeconds,
      recoveryGraceSeconds: nonNegativeInteger(row[4]) ?? defaults.recoveryGraceSeconds,
      pausedPolicy: pausedPolicies.includes(row[5] as PausedPolicy)
        ? row[5] as PausedPolicy
        : defaults.pausedPolicy,
      pausedGraceSeconds: nonNegativeInteger(row[6]) ?? defaults.pausedGraceSeconds,
      updatedAt: typeof row[7] === "string" ? row[7] : null,
    };
  }

  saveSettings(settings: BandwidthSettings): void {
    this.#db.query(
      `INSERT INTO bandwidth_automation_settings (
        id, enabled, throttle_bytes_per_second, throttle_unit, poll_interval_seconds,
        recovery_grace_seconds, paused_policy, paused_grace_seconds, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        throttle_bytes_per_second = excluded.throttle_bytes_per_second,
        throttle_unit = excluded.throttle_unit,
        poll_interval_seconds = excluded.poll_interval_seconds,
        recovery_grace_seconds = excluded.recovery_grace_seconds,
        paused_policy = excluded.paused_policy,
        paused_grace_seconds = excluded.paused_grace_seconds,
        updated_at = excluded.updated_at`,
      [
        settings.enabled ? 1 : 0,
        settings.throttleBytesPerSecond,
        settings.throttleUnit,
        settings.pollIntervalSeconds,
        settings.recoveryGraceSeconds,
        settings.pausedPolicy,
        settings.pausedGraceSeconds,
        settings.updatedAt ?? new Date().toISOString(),
      ],
    );
  }

  getState(): BandwidthControllerState {
    const row = firstRow(
      this.#db,
      `SELECT mode, owns_limit, prior_limit_bytes_per_second, applied_limit_bytes_per_second,
        restore_pending, last_change_at, last_change_from_bytes_per_second,
        last_change_to_bytes_per_second, last_change_reason
      FROM bandwidth_automation_state WHERE id = 1`,
    );

    if (!row) {
      return { ...initialControllerState };
    }

    const lastChangeTo = nonNegativeInteger(row[7]);
    return {
      mode: row[0] === "throttled" ? "throttled" : "unrestricted",
      ownsLimit: Number(row[1]) === 1,
      priorLimitBytesPerSecond: nonNegativeInteger(row[2]),
      appliedLimitBytesPerSecond: nonNegativeInteger(row[3]),
      restorePending: Number(row[4]) === 1,
      lastChange: typeof row[5] === "string" && lastChangeTo !== null
        ? {
          at: row[5],
          fromBytesPerSecond: nonNegativeInteger(row[6]),
          toBytesPerSecond: lastChangeTo,
          reason: typeof row[8] === "string" ? row[8] : "",
        }
        : null,
    };
  }

  saveState(state: BandwidthControllerState): void {
    this.#db.query(
      `INSERT INTO bandwidth_automation_state (
        id, mode, owns_limit, prior_limit_bytes_per_second, applied_limit_bytes_per_second,
        restore_pending, last_change_at, last_change_from_bytes_per_second,
        last_change_to_bytes_per_second, last_change_reason, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mode = excluded.mode,
        owns_limit = excluded.owns_limit,
        prior_limit_bytes_per_second = excluded.prior_limit_bytes_per_second,
        applied_limit_bytes_per_second = excluded.applied_limit_bytes_per_second,
        restore_pending = excluded.restore_pending,
        last_change_at = excluded.last_change_at,
        last_change_from_bytes_per_second = excluded.last_change_from_bytes_per_second,
        last_change_to_bytes_per_second = excluded.last_change_to_bytes_per_second,
        last_change_reason = excluded.last_change_reason,
        updated_at = excluded.updated_at`,
      [
        state.mode,
        state.ownsLimit ? 1 : 0,
        state.priorLimitBytesPerSecond,
        state.appliedLimitBytesPerSecond,
        state.restorePending ? 1 : 0,
        state.lastChange?.at ?? null,
        state.lastChange?.fromBytesPerSecond ?? null,
        state.lastChange?.toBytesPerSecond ?? null,
        state.lastChange?.reason ?? null,
        new Date().toISOString(),
      ],
    );
  }
}

function firstRow(db: DB, sql: string): unknown[] | null {
  for (const row of db.query(sql)) {
    return row;
  }

  return null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return value !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = Number(value);
  return value !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
