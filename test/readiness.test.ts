import { describe, it, expect } from "vitest";
import { computeReadiness, readinessLookbackDays } from "../src/readiness.js";
import type { Config, WellnessEntry } from "../src/types.js";

const READINESS_CONFIG: Config["readiness"] = {
  enabled: true,
  recent_days: 4,
  baseline_days: 28,
  min_baseline_samples: 14,
  hrv_drop_sd: 1.5,
  rhr_rise_bpm: 7,
  rhr_artifact_bpm: 25,
  steps_enabled: true,
  step_threshold: 12000,
  step_lookback_days: 7,
  step_days_required: 4,
  min_step_samples: 5,
};

// Minimal Config — computeReadiness only reads config.readiness.
const makeConfig = (overrides: Partial<Config["readiness"]> = {}): Config =>
  ({ readiness: { ...READINESS_CONFIG, ...overrides } }) as Config;

// Build a wellness range ending today: `baseline` fills the older days, `recent`
// the most recent `recent_days`. Dates count back day-by-day from 2026-06-23.
function makeRange(opts: {
  baselineHrv?: number[];
  recentHrv?: number[];
  baselineRhr?: number[];
  recentRhr?: number[];
  // Step counts for the trailing days of the range, oldest-first — i.e.
  // `steps.at(-1)` lands on the newest entry. `null` marks a day the wellness
  // source never populated, which is the common case for "today".
  steps?: (number | null)[];
}): WellnessEntry[] {
  const recentLen = Math.max(opts.recentHrv?.length ?? 0, opts.recentRhr?.length ?? 0);
  const baseLen = Math.max(opts.baselineHrv?.length ?? 0, opts.baselineRhr?.length ?? 0);
  // Steps can be supplied on their own (no HRV/RHR at all), so they set the
  // range length when nothing else does.
  const total = Math.max(baseLen + recentLen, opts.steps?.length ?? 0);
  const out: WellnessEntry[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(2026, 5, 23) - (total - 1 - i) * 86_400_000);
    const isRecent = i >= baseLen;
    const idx = isRecent ? i - baseLen : i;
    const hrv = isRecent ? opts.recentHrv?.[idx] : opts.baselineHrv?.[idx];
    const rhr = isRecent ? opts.recentRhr?.[idx] : opts.baselineRhr?.[idx];
    // Right-align steps against the end of the range so the caller writes the
    // window it cares about without counting baseline days.
    const stepIdx = opts.steps ? i - (total - opts.steps.length) : -1;
    const steps = stepIdx >= 0 ? opts.steps![stepIdx] : undefined;
    out.push({
      date: d.toISOString().slice(0, 10),
      ctl: 50,
      atl: 50,
      tsb: 0,
      ...(hrv !== undefined ? { hrvSDNN: hrv } : {}),
      ...(rhr !== undefined ? { restingHR: rhr } : {}),
      ...(typeof steps === "number" ? { steps } : {}),
    });
  }
  return out;
}

describe("computeReadiness", () => {
  it("returns unknown when disabled", () => {
    const range = makeRange({ baselineHrv: Array(20).fill(60), recentHrv: [40, 40, 40, 40] });
    expect(computeReadiness(range, makeConfig({ enabled: false })).status).toBe("unknown");
  });

  it("returns unknown without enough baseline samples", () => {
    const range = makeRange({ baselineHrv: Array(10).fill(60), recentHrv: [40, 40, 40, 40] });
    expect(computeReadiness(range, makeConfig()).status).toBe("unknown");
  });

  it("flags suppressed on a clear HRV drop past the SD threshold", () => {
    // baseline mean 60, sd ~5; recent mean 45 ≈ 3σ below → suppressed
    const baselineHrv = [55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 60, 60];
    const range = makeRange({ baselineHrv, recentHrv: [45, 45, 45, 45] });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("suppressed");
    expect(r.hrvDeviationSd!).toBeLessThanOrEqual(-1.5);
    expect(r.reason).toContain("HRV");
  });

  it("stays normal for a small HRV dip within the band", () => {
    const baselineHrv = [55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 60, 60];
    const range = makeRange({ baselineHrv, recentHrv: [58, 58, 58, 58] });
    expect(computeReadiness(range, makeConfig()).status).toBe("normal");
  });

  it("flags suppressed on an elevated resting HR even when HRV is absent", () => {
    const range = makeRange({ baselineRhr: Array(20).fill(48), recentRhr: [56, 56, 56, 56] });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("suppressed");
    expect(r.rhrDeltaBpm!).toBeGreaterThanOrEqual(7);
    expect(r.reason).toContain("resting HR");
  });

  it("stays normal for a resting HR rise below the threshold", () => {
    const range = makeRange({ baselineRhr: Array(20).fill(48), recentRhr: [51, 51, 51, 51] });
    expect(computeReadiness(range, makeConfig()).status).toBe("normal");
  });

  it("ignores a single implausible reading in the recent window (artifact ceiling)", () => {
    // One 102 bpm artifact among otherwise-normal mornings. The ceiling
    // (baseline_median 56 + 25 = 81) drops 102 before the median is taken, so
    // recRhr is [52, 60, 64] → +2 bpm → normal.
    const range = makeRange({
      baselineRhr: Array(20).fill(56),
      recentRhr: [102, 52, 60, 64],
    });
    expect(computeReadiness(range, makeConfig()).status).toBe("normal");
  });

  it("relies on the median for a single gray-zone outlier the ceiling keeps", () => {
    // 80 bpm is below the ceiling (56 + 25 = 81) so it survives the filter. The
    // recent-window median is what resists it here: median([52, 60, 64, 80]) =
    // 62 → +6 bpm → normal. A mean would read 64 → +8 bpm and fire. This pins the
    // median's independent value for mid-range outliers the artifact ceiling
    // does not catch.
    const range = makeRange({
      baselineRhr: Array(20).fill(56),
      recentRhr: [80, 52, 60, 64],
    });
    expect(computeReadiness(range, makeConfig()).status).toBe("normal");
  });

  it("drops ride-day artifacts that dominate the recent window (the real-world bug)", () => {
    // A ride-heavy week: Intervals.icu overwrote the wellness restingHR with a
    // per-ride "resting HR" estimate on two of the four recent days (106, 110),
    // against a true ~55 baseline. The median alone reads median([55,60,106,110])
    // = 83 → +28 bpm → false alarm (this is exactly what fired on 2026-06-24).
    // The artifact ceiling (baseline_median 55 + 25 = 80) drops 106 and 110
    // before the median, leaving [55, 60] → +2.5 bpm → normal.
    const range = makeRange({
      baselineRhr: Array(20).fill(55),
      recentRhr: [60, 106, 55, 110],
    });
    expect(computeReadiness(range, makeConfig()).status).toBe("normal");
  });

  it("still fires on a genuine elevation below the artifact ceiling", () => {
    // +12 bpm is above rhr_rise_bpm (7) but below the artifact ceiling (25), so
    // it's treated as a real physiological signal, not dropped.
    const range = makeRange({ baselineRhr: Array(20).fill(50), recentRhr: [62, 62, 62, 62] });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("suppressed");
    expect(r.reason).toContain("resting HR");
  });

  it("abstains when artifacts leave too few recent readings to judge", () => {
    // Only two recent readings and one is an artifact: dropping it leaves a
    // single reading (below MIN_RECENT_SAMPLES), so RHR readiness abstains rather
    // than acting on the lone survivor.
    const entries: WellnessEntry[] = [];
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.UTC(2026, 4, 24) + i * 86_400_000); // 2026-05-24 .. 06-12
      entries.push({ date: d.toISOString().slice(0, 10), ctl: 50, atl: 50, tsb: 0, restingHR: 56 });
    }
    entries.push({ date: "2026-06-22", ctl: 50, atl: 50, tsb: 0, restingHR: 52 });
    entries.push({ date: "2026-06-23", ctl: 50, atl: 50, tsb: 0, restingHR: 110 }); // artifact
    expect(computeReadiness(entries, makeConfig()).status).toBe("unknown");
  });

  it("never suppresses on a flat baseline (sd 0 → no usable spread)", () => {
    // All baseline HRV identical → SD 0 → deviation can't be scored, so even a
    // large recent drop must not fire.
    const range = makeRange({ baselineHrv: Array(16).fill(60), recentHrv: [30, 30, 30, 30] });
    expect(computeReadiness(range, makeConfig()).status).not.toBe("suppressed");
  });

  it("abstains when the recent window has only one reading (median can't resist an artifact)", () => {
    // Sparse logging: 20 baseline readings, then a gap, then a single recent
    // morning. Only that one entry falls in the date-based recent window.
    const entries: WellnessEntry[] = [];
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.UTC(2026, 4, 24) + i * 86_400_000); // 2026-05-24 .. 06-12
      entries.push({ date: d.toISOString().slice(0, 10), ctl: 50, atl: 50, tsb: 0, restingHR: 50 });
    }
    entries.push({ date: "2026-06-23", ctl: 50, atl: 50, tsb: 0, restingHR: 80 });
    expect(computeReadiness(entries, makeConfig()).status).toBe("unknown");
  });

  it("reports both signals in the reason when HRV and RHR are simultaneously suppressed", () => {
    const baselineHrv = [55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 60, 60];
    const range = makeRange({
      baselineHrv,
      recentHrv: [44, 44, 44, 44],
      baselineRhr: Array(16).fill(50),
      recentRhr: [60, 60, 60, 60],
    });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("suppressed");
    expect(r.reason).toContain("HRV");
    expect(r.reason).toContain("resting HR");
    expect(r.reason).toContain(", "); // both bits joined
  });

  // --- non-bike load (steps) ---
  //
  // Every case below pairs the step window with a calm HRV/RHR backdrop, so
  // whatever fires (or doesn't) is the step signal alone.
  const CALM = {
    baselineHrv: [55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 60, 60],
    recentHrv: [60, 60, 60, 60],
    baselineRhr: Array(16).fill(52),
    recentRhr: [52, 52, 52, 52],
  };

  it("suppresses on a sustained run of high-step days even when HRV and RHR are calm", () => {
    // The 2026-09-07 case: nine days of Alaska hiking at 13-19k steps against a
    // ~6.7k normal. TSB read +23.5 ("fresh") because none of it was logged as
    // an activity; the step window is what sees it.
    const range = makeRange({
      ...CALM,
      steps: [17443, 13162, 16366, null, 16990, 18110, 18826],
    });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("suppressed");
    expect(r.highStepDays).toBe(6);
    expect(r.reason).toContain("12,000 steps");
  });

  it("stays normal for a single big walk in an otherwise ordinary week", () => {
    // One 18k day (a day hike) among normal days: 1 < step_days_required (4), so
    // the week is untouched. This is the sustained-vs-one-off distinction.
    const range = makeRange({
      ...CALM,
      steps: [6200, 5800, 18400, 6900, 7100, 6400, 5900],
    });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("normal");
    expect(r.highStepDays).toBe(1);
  });

  it("counts a day exactly at the threshold as high-step", () => {
    const range = makeRange({
      ...CALM,
      steps: [12000, 12000, 12000, 12000, 6000, 6000, 6000],
    });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("suppressed");
    expect(r.highStepDays).toBe(4);
  });

  it("does not count days just below the threshold", () => {
    const range = makeRange({
      ...CALM,
      steps: [11999, 11999, 11999, 11999, 6000, 6000, 6000],
    });
    expect(computeReadiness(range, makeConfig()).highStepDays).toBe(0);
  });

  it("abstains on steps when too few days in the window carry a count", () => {
    // Only 4 populated days against min_step_samples 5 — all of them high. A
    // sparse window can't distinguish "a hard week" from "the source synced the
    // four days I happened to walk", so the step signal reports nothing rather
    // than acting. HRV/RHR still answer, hence "normal" not "unknown".
    const range = makeRange({
      ...CALM,
      steps: [null, 18000, null, 17000, 19000, null, 16000],
    });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("normal");
    expect(r.highStepDays).toBeUndefined();
    expect(r.stepSampleDays).toBeUndefined();
  });

  it("tolerates a missing count for today, the normal Intervals.icu state", () => {
    // `steps` for the newest entry is null until the wellness source syncs. The
    // window is anchored on the entry date regardless, so the six populated days
    // behind it still decide the verdict.
    const range = makeRange({
      ...CALM,
      steps: [16000, 15000, 17000, 16500, 6000, 6200, null],
    });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("suppressed");
    expect(r.stepSampleDays).toBe(6);
    expect(r.highStepDays).toBe(4);
  });

  it("ignores zero-step days rather than counting them as data", () => {
    // A literal 0 is how some sources report "no data", not a motionless day.
    // Dropping the two zeros leaves 5 populated days — exactly min_step_samples.
    const range = makeRange({
      ...CALM,
      steps: [0, 0, 16000, 15000, 17000, 16500, 6000],
    });
    const r = computeReadiness(range, makeConfig());
    expect(r.stepSampleDays).toBe(5);
    expect(r.status).toBe("suppressed");
  });

  it("ignores steps entirely when steps_enabled is false", () => {
    const range = makeRange({
      ...CALM,
      steps: [17443, 13162, 16366, 18110, 16990, 18826, 15000],
    });
    const r = computeReadiness(range, makeConfig({ steps_enabled: false }));
    expect(r.status).toBe("normal");
    expect(r.highStepDays).toBeUndefined();
  });

  it("fires on steps alone with no HRV or resting-HR history at all", () => {
    // A step-only account (no morning HRV source) still gets the guard: steps
    // are scored against an absolute threshold, so they need no baseline.
    const range = makeRange({ steps: [17443, 13162, 16366, 18110, 16990, 18826, 15000] });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("suppressed");
    expect(r.hrvDeviationSd).toBeUndefined();
    expect(r.reason).toContain("steps");
  });

  it("stays unknown when neither HRV/RHR nor steps have enough data", () => {
    const range = makeRange({ steps: [6000, null, 6200, null] });
    expect(computeReadiness(range, makeConfig()).status).toBe("unknown");
  });

  it("names every firing signal in the reason when steps and HRV coincide", () => {
    const range = makeRange({
      baselineHrv: [55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 55, 65, 60, 60],
      recentHrv: [44, 44, 44, 44],
      steps: [17443, 13162, 16366, 18110, 16990, 18826, 15000],
    });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("suppressed");
    expect(r.reason).toContain("HRV");
    expect(r.reason).toContain("steps");
  });

  it("reports the step count on a normal week so a rising trend is visible", () => {
    const range = makeRange({ ...CALM, steps: [13000, 6000, 14000, 6100, 6200, 6000, 5900] });
    const r = computeReadiness(range, makeConfig());
    expect(r.status).toBe("normal");
    expect(r.highStepDays).toBe(2);
    expect(r.stepSampleDays).toBe(7);
  });
});

describe("readinessLookbackDays", () => {
  it("covers the HRV baseline window under the shipped defaults", () => {
    // 28 + 4 = 32 comfortably exceeds the 7-day step window, so the HRV
    // requirement is what sets the fetch depth.
    expect(readinessLookbackDays(makeConfig())).toBe(32);
  });

  it("widens to the step window when it reaches past the HRV window", () => {
    // A longer expedition setting: without this the caller would fetch only 32
    // days, the 45-day step window would truncate to what was fetched, and the
    // step guard would abstain forever with no error — the silent-failure mode
    // this helper exists to prevent.
    expect(readinessLookbackDays(makeConfig({ step_lookback_days: 45 }))).toBe(45);
  });

  it("ignores the step window when steps are disabled", () => {
    const config = makeConfig({ steps_enabled: false, step_lookback_days: 45 });
    expect(readinessLookbackDays(config)).toBe(32);
  });

  it("still covers the step window when the HRV windows are narrowed", () => {
    // The other direction of the same bug: short HRV windows must not shrink
    // the fetch below what the step signal needs.
    const config = makeConfig({ baseline_days: 10, recent_days: 2, step_lookback_days: 14 });
    expect(readinessLookbackDays(config)).toBe(14);
  });
});
