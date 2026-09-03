export type LeafPerfTraceEvent = {
  at: number;
  durationMs: number;
  label: string;
};

type LeafPerfTrace = {
  events: LeafPerfTraceEvent[];
};

type LeafPerfTraceHost = typeof globalThis & {
  __leafPerfTrace?: LeafPerfTrace;
};

function getLeafPerfTraceHost() {
  return globalThis as LeafPerfTraceHost;
}

function getLeafPerfTrace() {
  return getLeafPerfTraceHost().__leafPerfTrace ?? null;
}

export function installLeafPerfTrace() {
  const trace: LeafPerfTrace = { events: [] };
  getLeafPerfTraceHost().__leafPerfTrace = trace;
  return trace;
}

export function getLeafPerfTraceEvents() {
  return getLeafPerfTrace()?.events ?? null;
}

export function recordLeafPerfTrace(label: string, durationMs = 0, at?: number) {
  const trace = getLeafPerfTrace();
  if (!trace) return;
  trace.events.push({ at: at ?? performance.now(), durationMs, label });
}

export function timeLeafPerfTrace<T>(label: string, callback: () => T): T {
  const trace = getLeafPerfTrace();
  if (!trace) return callback();

  const startedAt = performance.now();
  try {
    return callback();
  } finally {
    trace.events.push({ at: startedAt, durationMs: performance.now() - startedAt, label });
  }
}

export async function timeLeafPerfTraceAsync<T>(
  label: string,
  callback: () => Promise<T>,
): Promise<T> {
  const trace = getLeafPerfTrace();
  if (!trace) return await callback();
  const startedAt = performance.now();
  try {
    return await callback();
  } finally {
    trace.events.push({ at: startedAt, durationMs: performance.now() - startedAt, label });
  }
}
