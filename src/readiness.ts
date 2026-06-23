import type { WellnessEntry, Config } from "./types.js";

export type ReadinessStatus = "suppressed" | "normal" | "unknown";

export interface ReadinessSignal {
  status: ReadinessStatus;
  hrvDeviationSd?: number; // (recent HRV mean − baseline mean) / baseline SD; negative = parasympathetic suppression
  rhrDeltaBpm?: number; // recent resting-HR mean − baseline mean; positive = elevated
  reason?: string; // human-readable summary for the status line, set only when suppressed
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

// Median — used for the small recent window (and the baseline RHR centre) so a
// single implausible morning reading (e.g. a 102 bpm "resting" HR that's really
// a measurement artifact) can't swing a 4-day average into a false alarm.
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Sample standard deviation (n−1). Returns 0 for fewer than two points so the
// caller can treat a degenerate baseline as "no usable spread" rather than NaN.
const stdev = (xs: number[], mu: number): number =>
  xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1));

// Compare a short trailing window of HRV / resting-HR against a longer baseline.
// Single-day HRV is noisy, so we average the most recent `recent_days` and test
// that against the mean ± SD of the preceding `baseline_days` (the
// HRV4Training/Oura "normal range" approach). Returns "suppressed" only — like
// the CTL ramp guard, readiness can downgrade a week but never inflate it. When
// readiness is disabled or there isn't enough baseline data, returns "unknown"
// and the scheduler proceeds on TSB alone, exactly as before this existed.
export function computeReadiness(range: WellnessEntry[], config: Config): ReadinessSignal {
  const r = config.readiness;
  if (!r?.enabled) return { status: "unknown" };

  const sorted = [...range].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-r.recent_days);
  const baseline = sorted.slice(-(r.recent_days + r.baseline_days), -r.recent_days);

  const pick = (es: WellnessEntry[], key: "hrvSDNN" | "restingHR"): number[] =>
    es.map((e) => e[key]).filter((v): v is number => typeof v === "number" && v > 0);

  const recHrv = pick(recent, "hrvSDNN");
  const baseHrv = pick(baseline, "hrvSDNN");
  const recRhr = pick(recent, "restingHR");
  const baseRhr = pick(baseline, "restingHR");

  const haveHrv = recHrv.length >= 1 && baseHrv.length >= r.min_baseline_samples;
  const haveRhr = recRhr.length >= 1 && baseRhr.length >= r.min_baseline_samples;
  if (!haveHrv && !haveRhr) return { status: "unknown" };

  let hrvDeviationSd: number | undefined;
  if (haveHrv) {
    // Baseline mean ± SD set the z-score scale (28 samples dilute outliers);
    // the recent window uses the median to resist a single bad reading.
    const mu = mean(baseHrv);
    const sd = stdev(baseHrv, mu);
    // A flat baseline (sd 0) can't say anything about deviation magnitude.
    hrvDeviationSd = sd > 0 ? (median(recHrv) - mu) / sd : 0;
  }
  const rhrDeltaBpm = haveRhr ? median(recRhr) - median(baseRhr) : undefined;

  const hrvLow = hrvDeviationSd !== undefined && hrvDeviationSd <= -r.hrv_drop_sd;
  const rhrHigh = rhrDeltaBpm !== undefined && rhrDeltaBpm >= r.rhr_rise_bpm;

  if (hrvLow || rhrHigh) {
    const bits: string[] = [];
    if (hrvLow) bits.push(`HRV ${hrvDeviationSd!.toFixed(1)}σ below baseline`);
    if (rhrHigh) bits.push(`resting HR +${rhrDeltaBpm!.toFixed(0)} bpm`);
    return { status: "suppressed", hrvDeviationSd, rhrDeltaBpm, reason: bits.join(", ") };
  }
  return { status: "normal", hrvDeviationSd, rhrDeltaBpm };
}
