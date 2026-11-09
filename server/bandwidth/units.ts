/**
 * Network rates use decimal units: 1 Mb/s is 1,000,000 bits/s (125,000 bytes/s) and 1 MB/s is
 * 1,000,000 bytes/s, so 80 Mb/s = 10 MB/s. Limits are stored and sent in bytes per second.
 *
 * SABnzbd counts in binary units and labels them "MB/s" (1 MiB = 1,048,576 bytes), so it shows a
 * 10 MB/s limit as about 9.5 "MB/s".
 */

export type ThrottleUnit = "Mbps" | "MBps";

export const throttleUnits: readonly ThrottleUnit[] = ["Mbps", "MBps"];

export const BYTES_PER_MEGABIT = 125_000;
export const BYTES_PER_MEGABYTE = 1_000_000;

export function isThrottleUnit(value: unknown): value is ThrottleUnit {
  return value === "Mbps" || value === "MBps";
}

export function bytesPerUnit(unit: ThrottleUnit): number {
  return unit === "Mbps" ? BYTES_PER_MEGABIT : BYTES_PER_MEGABYTE;
}

/** e.g. (80, "Mbps") -> 10,000,000 bytes/s. */
export function toBytesPerSecond(value: number, unit: ThrottleUnit): number {
  return Math.round(value * bytesPerUnit(unit));
}

/** e.g. (10,000,000, "Mbps") -> 80. */
export function fromBytesPerSecond(bytesPerSecond: number, unit: ThrottleUnit): number {
  return bytesPerSecond / bytesPerUnit(unit);
}

/** "unlimited" for 0, otherwise e.g. "80 Mb/s (10 MB/s)". For logs and notices. */
export function formatLimit(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) {
    return "unknown";
  }

  if (bytesPerSecond <= 0) {
    return "unlimited";
  }

  return `${formatNumber(fromBytesPerSecond(bytesPerSecond, "Mbps"))} Mb/s (${
    formatNumber(fromBytesPerSecond(bytesPerSecond, "MBps"))
  } MB/s)`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}
