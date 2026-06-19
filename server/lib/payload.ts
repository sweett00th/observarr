export type PayloadSummary = {
  type: string;
  keys: string[];
  sizeBytes: number;
};

export function summarizePayload(payload: unknown): PayloadSummary {
  const serialized = JSON.stringify(payload ?? null);

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      type: Array.isArray(payload) ? "array" : typeof payload,
      keys: [],
      sizeBytes: new TextEncoder().encode(serialized).length,
    };
  }

  return {
    type: "object",
    keys: Object.keys(payload as Record<string, unknown>).slice(0, 20),
    sizeBytes: new TextEncoder().encode(serialized).length,
  };
}
