import { describe, it, expect, vi } from "vitest";
import {
  parseArgs,
  formatPlan,
  formatReadiness,
  workoutToEvent,
  computeWeeklyRampPct,
  resolveRaceDate,
  weeksUntil,
  latestTrainingLoad,
  pushPlan,
} from "../src/cli.js";
import type { PlannedWorkout, WellnessEntry, IntervalsEvent } from "../src/types.js";

describe("parseArgs", () => {
  it("parses 'plan' command", () => {
    const result = parseArgs(["plan"]);
    expect(result).toEqual({ command: "plan", dryRun: false, json: false });
  });

  it("parses 'plan --dry-run' command", () => {
    const result = parseArgs(["plan", "--dry-run"]);
    expect(result).toEqual({ command: "plan", dryRun: true, json: false });
  });

  it("parses 'status' command", () => {
    const result = parseArgs(["status"]);
    expect(result).toEqual({ command: "status", dryRun: false, json: false });
  });

  it("parses 'status --json' command", () => {
    const result = parseArgs(["status", "--json"]);
    expect(result).toEqual({ command: "status", dryRun: false, json: true });
  });

  it("parses 'check' command", () => {
    const result = parseArgs(["check"]);
    expect(result).toEqual({ command: "check", dryRun: false, json: false });
  });

  it("throws on unknown command", () => {
    expect(() => parseArgs(["foo"])).toThrow("Unknown command");
  });

  it("throws on no command", () => {
    expect(() => parseArgs([])).toThrow("No command");
  });
});

describe("formatReadiness", () => {
  it("summarizes a suppressed signal with its reason and the planner effect", () => {
    const out = formatReadiness({ status: "suppressed", reason: "HRV -1.7σ below baseline" });
    expect(out).toContain("suppressed");
    expect(out).toContain("HRV -1.7σ below baseline");
    expect(out).toContain("one tier");
  });

  it("renders normal and unknown plainly", () => {
    expect(formatReadiness({ status: "normal" })).toBe("normal");
    expect(formatReadiness({ status: "unknown" })).toContain("n/a");
  });
});

describe("formatPlan", () => {
  const week: PlannedWorkout[] = [
    {
      date: "2026-04-20",
      type: "cycling",
      name: "Hard Ride",
      description: "Threshold intervals",
      intensity: "hard",
    },
    {
      date: "2026-04-21",
      type: "weights",
      name: "Strength",
      description: "Squats and stuff",
      intensity: "hard",
    },
    {
      date: "2026-04-22",
      type: "sweet_spot",
      name: "Sweet Spot Intervals",
      description: "4x10 at 60rpm",
      intensity: "hard",
    },
    {
      date: "2026-04-23",
      type: "rest",
      name: "Rest Day",
      description: "Recovery",
      intensity: "easy",
    },
  ];

  it("formats one line per workout with date and name", () => {
    const out = formatPlan(week);
    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("2026-04-20");
    expect(lines[0]).toContain("Hard Ride");
    expect(lines[0]).toContain("hard");
  });

  it("uses a distinct icon per workout type", () => {
    const out = formatPlan(week);
    expect(out).toContain("[CY]"); // cycling
    expect(out).toContain("[WT]"); // weights
    expect(out).toContain("[SS]"); // sweet_spot
    expect(out).toMatch(/\[ {2}\]/); // rest — two spaces
  });

  it("includes an abbreviated day-of-week for each date", () => {
    const out = formatPlan([week[0]]);
    // 2026-04-20 is a Monday
    expect(out).toContain("Mon");
  });

  it("returns an empty string for an empty plan", () => {
    expect(formatPlan([])).toBe("");
  });
});

describe("computeWeeklyRampPct", () => {
  function w(date: string, ctl: number): WellnessEntry {
    return { date, ctl, atl: 0, tsb: 0 };
  }

  it("returns undefined for an empty range", () => {
    expect(computeWeeklyRampPct([])).toBeUndefined();
  });

  it("returns undefined when the oldest CTL is zero", () => {
    expect(computeWeeklyRampPct([w("2026-04-19", 0), w("2026-04-26", 50)])).toBeUndefined();
  });

  it("computes ramp as (newest - oldest) / oldest * 100", () => {
    expect(computeWeeklyRampPct([w("2026-04-19", 50), w("2026-04-26", 53.5)])).toBeCloseTo(7, 5);
    expect(computeWeeklyRampPct([w("2026-04-19", 50), w("2026-04-26", 55)])).toBeCloseTo(10, 5);
  });

  it("handles entries arriving in any date order", () => {
    expect(computeWeeklyRampPct([w("2026-04-26", 55), w("2026-04-19", 50)])).toBeCloseTo(10, 5);
  });

  it("ignores today's zeroed entry instead of reporting a spurious -100% ramp", () => {
    // Today (06-09) is unsynced (ctl 0); ramp should come from the populated days.
    const range = [w("2026-06-02", 50), w("2026-06-08", 53), w("2026-06-09", 0)];
    expect(computeWeeklyRampPct(range)).toBeCloseTo(6, 5);
  });

  it("returns undefined when only one populated datapoint remains", () => {
    expect(computeWeeklyRampPct([w("2026-06-02", 50), w("2026-06-09", 0)])).toBeUndefined();
  });
});

describe("workoutToEvent", () => {
  it("maps cycling to a Ride workout", () => {
    const event = workoutToEvent({
      date: "2026-04-20",
      type: "cycling",
      name: "Hard Ride",
      description: "threshold",
      intensity: "hard",
    });
    expect(event).toEqual({
      // Intervals.icu rejects a bare date with a 422 — it needs a time component.
      start_date_local: "2026-04-20T00:00:00",
      name: "Hard Ride",
      category: "WORKOUT",
      type: "Ride",
      description: "threshold",
    });
  });

  it("appends a midnight time component so Intervals.icu accepts the date", () => {
    const event = workoutToEvent({
      date: "2026-04-22",
      type: "weights",
      name: "Strength",
      description: "",
      intensity: "hard",
    });
    expect(event.start_date_local).toBe("2026-04-22T00:00:00");
  });

  it("maps sweet_spot to a Ride workout", () => {
    const event = workoutToEvent({
      date: "2026-04-22",
      type: "sweet_spot",
      name: "LC",
      description: "",
      intensity: "hard",
    });
    expect(event.type).toBe("Ride");
    expect(event.category).toBe("WORKOUT");
  });

  it("maps weights to WeightTraining", () => {
    const event = workoutToEvent({
      date: "2026-04-21",
      type: "weights",
      name: "Strength",
      description: "",
      intensity: "hard",
    });
    expect(event.type).toBe("WeightTraining");
    expect(event.category).toBe("WORKOUT");
  });

  it("maps rest to a NOTE category", () => {
    const event = workoutToEvent({
      date: "2026-04-23",
      type: "rest",
      name: "Rest Day",
      description: "Recovery",
      intensity: "easy",
    });
    expect(event.category).toBe("NOTE");
    expect(event.type).toBe("Note");
  });

  it("maps planned-load targets to icu_training_load, moving_time, and icu_intensity", () => {
    const event = workoutToEvent({
      date: "2026-04-20",
      type: "cycling",
      name: "Sweet Spot Intervals",
      description: "",
      intensity: "hard",
      load: 77,
      durationMin: 60,
      intensityFactor: 0.88,
    });
    expect(event.icu_training_load).toBe(77);
    expect(event.moving_time).toBe(3600); // 60 min → seconds
    expect(event.icu_intensity).toBe(0.88);
  });

  it("omits planned-load fields when the workout has no targets", () => {
    const event = workoutToEvent({
      date: "2026-04-20",
      type: "cycling",
      name: "Hard Ride",
      description: "",
      intensity: "hard",
    });
    expect(event.icu_training_load).toBeUndefined();
    expect(event.moving_time).toBeUndefined();
    expect(event.icu_intensity).toBeUndefined();
  });

  it("emits a power-targeted structured workout for the sweet-spot session", () => {
    const event = workoutToEvent({
      date: "2026-04-22",
      type: "sweet_spot",
      name: "Sweet Spot Intervals",
      description: "long prose rationale",
      intensity: "hard",
      load: 77,
      durationMin: 60,
      intensityFactor: 0.88,
    });
    // Structured steps replace the prose so Intervals.icu derives target watts.
    expect(event.description).toContain("88-94%");
    expect(event.description).not.toContain("long prose rationale");
    // Duration and load follow the structured steps (72 min), not the config 60.
    expect(event.moving_time).toBe(72 * 60);
    expect(event.icu_training_load).toBe(Math.round((72 / 60) * 0.88 ** 2 * 100));
    expect(event.icu_intensity).toBe(0.88);
  });

  it("emits a power+HR structured workout for an easy ride", () => {
    const event = workoutToEvent({
      date: "2026-04-20",
      type: "cycling",
      name: "Easy Ride",
      description: "Easy ride — Zone 2 recovery spin",
      intensity: "easy",
      load: 48,
      durationMin: 75,
      intensityFactor: 0.62,
    });
    expect(event.description).toContain("62% Z2 HR"); // power target (load) + HR zone (display)
    expect(event.moving_time).toBe(75 * 60);
    // TSS is recomputed from the structured duration (here unchanged at 75 min).
    expect(event.icu_training_load).toBe(Math.round((75 / 60) * 0.62 ** 2 * 100));
  });

  it("matches submitted TSS/intensity to the rounded step percent, not the raw IF", () => {
    // A non-round IF rounds to 63% in the step text; the submitted TSS and IF
    // must follow that rounding so they agree with what Intervals.icu re-derives.
    const event = workoutToEvent({
      date: "2026-04-20",
      type: "cycling",
      name: "Easy Ride",
      description: "prose",
      intensity: "easy",
      durationMin: 75,
      intensityFactor: 0.625,
    });
    expect(event.description).toContain("63% Z2 HR");
    expect(event.icu_intensity).toBe(0.63);
    expect(event.icu_training_load).toBe(Math.round((75 / 60) * 0.63 ** 2 * 100));
  });

  it("leaves a hard ride with no target zone as prose (no deterministic structure)", () => {
    const event = workoutToEvent({
      date: "2026-04-20",
      type: "cycling",
      name: "Hard Ride",
      description: "Hard interval ride",
      intensity: "hard",
      durationMin: 75,
      intensityFactor: 0.88,
    });
    expect(event.description).toBe("Hard interval ride");
  });
});

describe("resolveRaceDate", () => {
  const ev = (date: string, category: string): IntervalsEvent => ({
    start_date_local: date,
    name: "x",
    category,
  });

  it("returns the earliest future RACE_A event date", () => {
    const events = [ev("2026-10-10T07:00:00", "RACE_A"), ev("2026-09-26T07:00:00", "RACE_A")];
    expect(resolveRaceDate(events, "2026-06-09", null)).toBe("2026-09-26");
  });

  it("ignores past races and non-race events", () => {
    const events = [ev("2026-01-01T07:00:00", "RACE_A"), ev("2026-09-26T07:00:00", "WORKOUT")];
    expect(resolveRaceDate(events, "2026-06-09", null)).toBeUndefined();
  });

  it("falls back to config race_date when no RACE_A is present", () => {
    expect(resolveRaceDate([], "2026-06-09", "2026-09-26")).toBe("2026-09-26");
  });

  it("ignores a past fallback race_date", () => {
    expect(resolveRaceDate([], "2026-06-09", "2026-01-01")).toBeUndefined();
  });
});

describe("weeksUntil", () => {
  it("rounds up partial weeks", () => {
    expect(weeksUntil("2026-06-09", "2026-06-09")).toBe(0);
    expect(weeksUntil("2026-06-09", "2026-06-10")).toBe(1);
    expect(weeksUntil("2026-06-09", "2026-09-26")).toBe(16);
  });
});

describe("latestTrainingLoad", () => {
  it("picks the most recent settled day before today, skipping an unpopulated today", () => {
    const range: WellnessEntry[] = [
      { date: "2026-06-07", ctl: 55, atl: 60, tsb: -5 },
      { date: "2026-06-08", ctl: 56, atl: 58, tsb: -2 },
      { date: "2026-06-09", ctl: 0, atl: 0, tsb: 0 }, // today, not computed yet
    ];
    expect(latestTrainingLoad(range, "2026-06-09")).toEqual({ ctl: 56, atl: 58, tsb: -2 });
  });

  it("ignores today's provisional entry even when populated (stable across sync)", () => {
    // Today has a populated but still-settling entry; yesterday is the stable
    // read the fatigue tier should be based on.
    const range: WellnessEntry[] = [
      { date: "2026-06-08", ctl: 52, atl: 45, tsb: 7 },
      { date: "2026-06-09", ctl: 51, atl: 48, tsb: 3 }, // today, mid-sync jitter
    ];
    expect(latestTrainingLoad(range, "2026-06-09")).toEqual({ ctl: 52, atl: 45, tsb: 7 });
  });

  it("falls back to today's entry when no earlier day has data (sync gap / new athlete)", () => {
    const range: WellnessEntry[] = [{ date: "2026-06-09", ctl: 51, atl: 48, tsb: 3 }];
    expect(latestTrainingLoad(range, "2026-06-09")).toEqual({ ctl: 51, atl: 48, tsb: 3 });
  });

  it("returns zeros when nothing is populated", () => {
    expect(
      latestTrainingLoad([{ date: "2026-06-09", ctl: 0, atl: 0, tsb: 0 }], "2026-06-09"),
    ).toEqual({
      ctl: 0,
      atl: 0,
      tsb: 0,
    });
  });

  it("returns zeros for an empty range", () => {
    expect(latestTrainingLoad([], "2026-06-09")).toEqual({ ctl: 0, atl: 0, tsb: 0 });
  });
});

describe("pushPlan", () => {
  const plan: PlannedWorkout[] = [
    {
      date: "2026-06-08",
      type: "cycling",
      name: "Easy Ride",
      description: "z2",
      intensity: "easy",
    },
    { date: "2026-06-09", type: "rest", name: "Rest Day", description: "off", intensity: "easy" },
    {
      date: "2026-06-10",
      type: "weights",
      name: "Strength",
      description: "lift",
      intensity: "hard",
    },
  ];

  it("skips rest days and pushes the rest", async () => {
    const createEvent = vi.fn().mockResolvedValue({});
    const result = await pushPlan({ createEvent }, plan, () => {});
    expect(createEvent).toHaveBeenCalledTimes(2); // rest day skipped
    expect(result.created).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it("records failures and keeps going", async () => {
    const createEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 boom"))
      .mockResolvedValueOnce({});
    const result = await pushPlan({ createEvent }, plan, () => {});
    expect(createEvent).toHaveBeenCalledTimes(2);
    expect(result.created).toHaveLength(1);
    expect(result.failed).toEqual([{ date: "2026-06-08", name: "Easy Ride", error: "503 boom" }]);
  });
});
