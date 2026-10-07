/**
 * CPU time consumed by a synchronous call, from `process.cpuUsage()` deltas.
 *
 * Speed assertions in tests compare against this rather than a wall-clock delta: a descheduled
 * vitest worker accrues wall time while it runs nothing, so on a loaded machine a ~0.1 s
 * computation measured 1.0-2.3 s of wall. CPU time counts only the time the process was
 * actually scheduled. `process.cpuUsage` is process-wide, so a test file that relies on this
 * must run its cases sequentially (no `.concurrent`).
 */
export interface CpuTimed<T> {
  readonly result: T;
  /** User plus system CPU time consumed by the call, in milliseconds. */
  readonly cpuMs: number;
}

const MICROSECONDS_PER_MILLISECOND = 1_000;

export function cpuTimeMs<T>(run: () => T): CpuTimed<T> {
  const before = process.cpuUsage();
  const result = run();
  const { user, system } = process.cpuUsage(before);
  return { result, cpuMs: (user + system) / MICROSECONDS_PER_MILLISECOND };
}
