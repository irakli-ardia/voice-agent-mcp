/** Time source. Wall-clock time for values, a monotonic reading for durations. */
export interface Clock {
  now(): Date;
  /** Milliseconds from an arbitrary origin; only differences are meaningful. */
  monotonicNow(): number;
}
