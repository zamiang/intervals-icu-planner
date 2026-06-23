import { describe, it, expect } from "vitest";
import { computeReadiness } from "../src/readiness.js";
import type { Config, WellnessEntry } from "../src/types.js";

const READINESS_CONFIG: Config["readiness"] = {
  enabled: true,
  recent_days: 4,
  baseline_days: 28,
  min_baseline_samples: 14,
  hrv_drop_sd: 1.5,
  rhr_rise_bpm: 7,
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
}): WellnessEntry[] {
  const recentLen = Math.max(opts.recentHrv?.length ?? 0, opts.recentRhr?.length ?? 0);
  const baseLen = Math.max(opts.baselineHrv?.length ?? 0, opts.baselineRhr?.length ?? 0);
  const total = baseLen + recentLen;
  const out: WellnessEntry[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(2026, 5, 23) - (total - 1 - i) * 86_400_000);
    const isRecent = i >= baseLen;
    const idx = isRecent ? i - baseLen : i;
    const hrv = isRecent ? opts.recentHrv?.[idx] : opts.baselineHrv?.[idx];
    const rhr = isRecent ? opts.recentRhr?.[idx] : opts.baselineRhr?.[idx];
    out.push({
      date: d.toISOString().slice(0, 10),
      ctl: 50,
      atl: 50,
      tsb: 0,
      ...(hrv !== undefined ? { hrvSDNN: hrv } : {}),
      ...(rhr !== undefined ? { restingHR: rhr } : {}),
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

  it("ignores a single implausible reading in the recent window (median, not mean)", () => {
    // One 102 bpm artifact among otherwise-normal mornings: a mean would read
    // ~+13 bpm and flag suppressed; the median (~62) stays under the threshold.
    const range = makeRange({
      baselineRhr: Array(20).fill(56),
      recentRhr: [102, 52, 60, 64],
    });
    expect(computeReadiness(range, makeConfig()).status).toBe("normal");
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
});
