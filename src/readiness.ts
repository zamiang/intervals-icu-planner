import type { WellnessEntry, Config } from "./types.js";

export type ReadinessStatus = "suppressed" | "normal" | "unknown";

export interface ReadinessSignal {
  status: ReadinessStatus;
  hrvDeviationSd?: number; // (recent HRV median − baseline mean) / baseline SD; negative = parasympathetic suppression
  rhrDeltaBpm?: number; // recent resting-HR median − baseline median; positive = elevated
  highStepDays?: number; // days in the step lookback window at or above `step_threshold`; undefined when the step signal abstained
  stepSampleDays?: number; // days in that window that carried a step count at all, so callers can tell "no high-step days" from "no step data"
  reason?: string; // human-readable summary for the status line, set only when suppressed
}

// Baseline centre/scale only — the recent window uses `median` (see below).
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

// `iso` (YYYY-MM-DD) shifted back `n` calendar days, in UTC so the date prefix
// is stable regardless of host timezone.
function isoMinusDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Below this many readings in the recent window, the median can't resist a lone
// artifact (median of one or two values just is, or averages, those values), so
// the outlier protection the median buys is weakened. We still compute a signal
// from a 2-sample window but won't act on a single reading.
const MIN_RECENT_SAMPLES = 2;

// Non-bike load from daily steps. CTL/ATL/TSB are built from logged activity
// TSS alone, so nine days of 15-20k steps on a hiking trip leave TSB reading
// "fresh" while the legs carry a week of real work. Counting *days over a
// threshold* (rather than averaging steps) is deliberate: it answers "has this
// been sustained?", which is the question TSB is blind to, and one big walk in
// an otherwise sedentary week can't reach `step_days_required`.
//
// Returns undefined counts when the signal abstains — steps disabled, or too
// few days in the window carry a count to judge coverage. Intervals.icu leaves
// today's `steps` null until the wellness source syncs, so a window is normally
// one short even when logging is perfect; `min_step_samples` is set below the
// window length to absorb that.
function evaluateSteps(
  sorted: WellnessEntry[],
  latest: string,
  r: Config["readiness"],
): { highStepDays?: number; stepSampleDays?: number; high: boolean } {
  if (!r.steps_enabled) return { high: false };
  const windowStart = isoMinusDays(latest, r.step_lookback_days - 1);
  const steps = sorted
    .filter((e) => e.date >= windowStart)
    .map((e) => e.steps)
    // `> 0`: a literal 0 is how some sources report "no data for this day"
    // rather than a genuinely motionless day, and either way a 0 can only ever
    // pull the count down — dropping it is the conservative reading.
    .filter((v): v is number => typeof v === "number" && v > 0);
  if (steps.length < r.min_step_samples) return { high: false };
  const highStepDays = steps.filter((v) => v >= r.step_threshold).length;
  return {
    highStepDays,
    stepSampleDays: steps.length,
    high: highStepDays >= r.step_days_required,
  };
}

// Compare a short trailing window of HRV / resting-HR against a longer baseline.
// Single-day HRV is noisy, so we average the most recent `recent_days` and test
// that against the mean ± SD of the preceding `baseline_days` (the
// HRV4Training/Oura "normal range" approach). A sustained run of high-step days
// (see evaluateSteps) suppresses on its own too, covering the non-bike load
// TSB cannot see. Returns "suppressed" only — like the CTL ramp guard,
// readiness can downgrade a week but never inflate it. When readiness is
// disabled or no input has enough data, returns "unknown" and the scheduler
// proceeds on TSB alone, exactly as before this existed.
export function computeReadiness(range: WellnessEntry[], config: Config): ReadinessSignal {
  const r = config.readiness;
  if (!r?.enabled) return { status: "unknown" };

  const sorted = [...range].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return { status: "unknown" };

  // Window by calendar date, not by entry count, anchored to the most recent
  // reading (a missing entry for today mustn't shift the windows). The recent
  // window is the last `recent_days` days; the baseline is the `baseline_days`
  // before that. Sparse logging then narrows a window rather than silently
  // pulling baseline-age days into "recent".
  const latest = sorted[sorted.length - 1].date;
  const recentStart = isoMinusDays(latest, r.recent_days - 1);
  const baselineStart = isoMinusDays(latest, r.recent_days - 1 + r.baseline_days);
  const recent = sorted.filter((e) => e.date >= recentStart);
  const baseline = sorted.filter((e) => e.date >= baselineStart && e.date < recentStart);

  const pick = (es: WellnessEntry[], key: "hrvSDNN" | "restingHR"): number[] =>
    es.map((e) => e[key]).filter((v): v is number => typeof v === "number" && v > 0);

  const recHrv = pick(recent, "hrvSDNN");
  const baseHrv = pick(baseline, "hrvSDNN");
  const rawRecRhr = pick(recent, "restingHR");
  const baseRhr = pick(baseline, "restingHR");

  // Baseline centre, reused as both the artifact ceiling reference and the delta
  // baseline below. The long baseline window (28 days) plus the median's own
  // outlier resistance keep this trustworthy without separately filtering the
  // baseline: it would take many artifact days to shift a 28-sample median.
  const baseRhrMedian = baseRhr.length > 0 ? median(baseRhr) : undefined;

  // Drop resting-HR readings implausibly far above baseline before taking the
  // recent-window median. Intervals.icu can overwrite a day's wellness restingHR
  // with a per-ride "resting HR" estimate derived from the activity file (which
  // has no genuine rest), yielding values like 102-110 against a true ~55
  // baseline. On a ride-heavy week several recent days carry this artifact at
  // once, so the median alone (built to resist a *single* outlier) gets
  // corrupted and fires a false alarm. The ceiling sits far above rhr_rise_bpm
  // (enforced in config validation), so a real elevation (overtraining/illness
  // rises gradually, single-to-low-double digits) still triggers; only
  // sensor-scale jumps are discarded.
  const recRhr =
    baseRhrMedian !== undefined && baseRhr.length >= r.min_baseline_samples
      ? rawRecRhr.filter((v) => v <= baseRhrMedian + r.rhr_artifact_bpm)
      : rawRecRhr;

  // Steps need no personal baseline (the threshold is absolute), so this stands
  // on its own: a step-only signal still fires on an account with no HRV strap,
  // and an HRV-only account behaves exactly as it did before steps existed.
  const stepSignal = evaluateSteps(sorted, latest, r);
  const stepCounts = {
    ...(stepSignal.highStepDays !== undefined ? { highStepDays: stepSignal.highStepDays } : {}),
    ...(stepSignal.stepSampleDays !== undefined
      ? { stepSampleDays: stepSignal.stepSampleDays }
      : {}),
  };

  const haveHrv = recHrv.length >= MIN_RECENT_SAMPLES && baseHrv.length >= r.min_baseline_samples;
  const haveRhr = recRhr.length >= MIN_RECENT_SAMPLES && baseRhr.length >= r.min_baseline_samples;
  // "unknown" only when *nothing* is judgeable. A usable step window is a
  // verdict even with no HRV/RHR history at all.
  if (!haveHrv && !haveRhr && stepSignal.highStepDays === undefined) {
    return { status: "unknown" };
  }

  let hrvDeviationSd: number | undefined;
  if (haveHrv) {
    // Baseline mean ± SD set the z-score scale (28 samples dilute outliers);
    // the recent window uses the median to resist a single bad reading.
    const mu = mean(baseHrv);
    const sd = stdev(baseHrv, mu);
    // A flat baseline (sd 0) can't say anything about deviation magnitude.
    hrvDeviationSd = sd > 0 ? (median(recHrv) - mu) / sd : 0;
  }
  const rhrDeltaBpm = haveRhr ? median(recRhr) - baseRhrMedian! : undefined;

  const hrvLow = hrvDeviationSd !== undefined && hrvDeviationSd <= -r.hrv_drop_sd;
  const rhrHigh = rhrDeltaBpm !== undefined && rhrDeltaBpm >= r.rhr_rise_bpm;

  if (hrvLow || rhrHigh || stepSignal.high) {
    const bits: string[] = [];
    if (hrvLow) bits.push(`HRV ${hrvDeviationSd!.toFixed(1)}σ below baseline`);
    if (rhrHigh) bits.push(`resting HR +${rhrDeltaBpm!.toFixed(0)} bpm`);
    if (stepSignal.high) {
      bits.push(
        `${stepSignal.highStepDays} of the last ${r.step_lookback_days} days ` +
          `≥ ${r.step_threshold.toLocaleString("en-US")} steps`,
      );
    }
    return {
      status: "suppressed",
      hrvDeviationSd,
      rhrDeltaBpm,
      ...stepCounts,
      reason: bits.join(", "),
    };
  }
  return { status: "normal", hrvDeviationSd, rhrDeltaBpm, ...stepCounts };
}
