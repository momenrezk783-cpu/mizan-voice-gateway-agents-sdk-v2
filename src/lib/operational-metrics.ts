/** Aggregates numeric latencies only; no transcripts, phone numbers or caller names. */
export function summarizeLatency(samples: number[]): { p50: number | null; p95: number | null; samples: number } {
  const values = samples.filter(value => Number.isFinite(value) && value >= 0 && value <= 120000).sort((a,b) => a-b);
  const percentile = (fraction: number): number | null => values.length ? Math.round(values[Math.ceil(fraction * values.length) - 1]) : null;
  return { p50: percentile(0.5), p95: percentile(0.95), samples: values.length };
}
