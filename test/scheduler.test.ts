import { describe, it, expect } from "vitest";
import {
  schedule,
  classifyFatigue,
  classifyExistingEvent,
  rampGuardTriggered,
  classifyPhase,
  phaseWeightSessions,
  downgradeOneTier,
} from "../src/scheduler.js";
import { emptyDistribution } from "../src/zones.js";
import type { SchedulerInput, IntervalsEvent, Config, PlannedWorkout } from "../src/types.js";

function isHardEntry(w: PlannedWorkout): boolean {
  return w.type === "weights" || w.type === "sweet_spot" || w.intensity === "hard";
}

const BASE_CONFIG: Config = {
  weight_training: {
    name: "Strength",
    duration_minutes: 60,
    description: "Squat, deadlift, etc.",
  },
  sweet_spot: {
    name: "Sweet Spot Intervals",
    duration_minutes: 60,
    description: "4x10min at 60rpm",
  },
  scheduling: {
    tsb_fresh: 5,
    tsb_fatigued: -10,
    tsb_very_fatigued: -20,
    weight_sessions: 2,
    weight_sessions_very_fatigued: 1,
    weight_sessions_taper: 1,
    min_weight_gap_days: 2,
    max_weekly_ramp_pct: 7,
    hard_cycling_days: 1,
  },
  load_targets: {
    easy_if: 0.62,
    easy_minutes: 75,
    long_minutes: 180,
    hard_if: 0.88,
    hard_minutes: 75,
    sweet_spot_if: 0.88,
  },
  periodization: {
    taper_weeks: 4,
    taper_zero_weeks: 1,
    race_date: null,
  },
  readiness: {
    enabled: true,
    recent_days: 4,
    baseline_days: 28,
    min_baseline_samples: 14,
    hrv_drop_sd: 1.5,
    rhr_rise_bpm: 7,
    rhr_artifact_bpm: 25,
  },
};

function makeInput(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    startDate: "2026-04-20",
    existingEvents: [],
    trainingLoad: { ctl: 50, atl: 45, tsb: 5 },
    xertInfo: {
      ftp: 250,
      ltp: 210,
      hie: 22,
      pp: 1100,
      training_status: "Fresh",
      focus: "Endurance",
    },
    config: BASE_CONFIG,
    ...overrides,
  };
}

describe("schedule", () => {
  it("covers all 7 distinct dates in the week", () => {
    const result = schedule(makeInput());
    const distinctDates = new Set(result.map((w) => w.date));
    expect(distinctDates.size).toBe(7);
    expect(distinctDates.has("2026-04-20")).toBe(true);
    expect(distinctDates.has("2026-04-26")).toBe(true);
  });

  it("includes exactly 1 sweet-spot session", () => {
    const result = schedule(makeInput());
    const lc = result.filter((w) => w.type === "sweet_spot");
    expect(lc).toHaveLength(1);
  });

  it("includes exactly 2 weight training sessions", () => {
    const result = schedule(makeInput());
    const wt = result.filter((w) => w.type === "weights");
    expect(wt).toHaveLength(2);
  });

  it("includes at least 1 rest day", () => {
    const result = schedule(makeInput());
    const rest = result.filter((w) => w.type === "rest");
    expect(rest.length).toBeGreaterThanOrEqual(1);
  });

  it("spaces weight sessions at least 2 days apart", () => {
    const result = schedule(makeInput());
    const weightDates = result.filter((w) => w.type === "weights").map((w) => w.date);
    expect(weightDates).toHaveLength(2);
    const diffDays =
      (new Date(weightDates[1]).getTime() - new Date(weightDates[0]).getTime()) /
      (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(2);
  });

  it("does not schedule hard workouts on consecutive dates", () => {
    const result = schedule(makeInput());
    const hardDates = new Set(result.filter((w) => isHardEntry(w)).map((w) => w.date));
    const sorted = [...hardDates].sort();
    for (let i = 1; i < sorted.length; i++) {
      const diff =
        (new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / (1000 * 60 * 60 * 24);
      if (diff === 1) {
        throw new Error(`Back-to-back hard dates: ${sorted[i - 1]} and ${sorted[i]}`);
      }
    }
  });

  it("respects existing events — does not overwrite them", () => {
    const existing: IntervalsEvent[] = [
      {
        id: 1,
        start_date_local: "2026-04-21",
        name: "Group Ride",
        category: "WORKOUT",
        type: "Ride",
      },
    ];
    const result = schedule(makeInput({ existingEvents: existing }));
    const tue = result.find((w) => w.date === "2026-04-21");
    // Should not be overwritten — no planned workout on that day
    expect(tue).toBeUndefined();
  });

  it("locks days when existing events carry a time suffix (T00:00:00)", () => {
    // Intervals.icu returns start_date_local with a time component, e.g.
    // "2026-04-21T00:00:00". The lock check must compare on the date prefix, or
    // it silently double-books days that already have events.
    const existing: IntervalsEvent[] = [
      {
        id: 1,
        start_date_local: "2026-04-21T00:00:00",
        name: "Group Ride",
        category: "WORKOUT",
        type: "Ride",
      },
    ];
    const result = schedule(makeInput({ existingEvents: existing }));
    const onLockedDay = result.filter((w) => w.date === "2026-04-21");
    expect(onLockedDay).toHaveLength(0);
  });

  it("locks days from completedDates that carry a time suffix", () => {
    // completedDates normally arrives pre-trimmed from the CLI, but the
    // scheduler normalizes it too — prove the timestamp path locks its day.
    const result = schedule(makeInput({ completedDates: ["2026-04-21T00:00:00"] }));
    const onLockedDay = result.filter((w) => w.date === "2026-04-21");
    expect(onLockedDay).toHaveLength(0);
  });

  it("schedules easy rides when fatigued (low TSB)", () => {
    const result = schedule(
      makeInput({
        trainingLoad: { ctl: 50, atl: 70, tsb: -15 },
      }),
    );
    const cycling = result.filter((w) => w.type === "cycling");
    for (const ride of cycling) {
      expect(ride.intensity).toBe("easy");
    }
  });

  it("returns an empty plan when every day is already locked", () => {
    const existing: IntervalsEvent[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date("2026-04-20T00:00:00");
      d.setDate(d.getDate() + i);
      existing.push({
        id: i + 1,
        start_date_local: d.toISOString().slice(0, 10),
        name: "Existing",
        category: "WORKOUT",
        type: "Ride",
      });
    }
    const result = schedule(makeInput({ existingEvents: existing }));
    expect(result).toHaveLength(0);
  });

  it("fills non-quality cycling with easy Zone 2 when TSB is between thresholds", () => {
    const result = schedule(
      makeInput({
        trainingLoad: { ctl: 50, atl: 52, tsb: 0 },
      }),
    );
    const cycling = result.filter((w) => w.type === "cycling");
    expect(cycling.length).toBeGreaterThan(0);
    // 80/20 policy: a moderate-TSB week has no hard cycling targets, so every
    // filled ride is easy — never the grey-zone "moderate".
    for (const ride of cycling) {
      expect(ride.intensity).toBe("easy");
    }
  });

  it("treats TSB exactly at tsb_fresh as moderate fatigue → all-easy fills", () => {
    const result = schedule(
      makeInput({
        // tsb_fresh is 5; classifyFatigue uses strict `>`, so 5 is moderate,
        // which means no hard cycling targets and an all-easy cycling fill.
        trainingLoad: { ctl: 50, atl: 45, tsb: 5 },
      }),
    );
    const cycling = result.filter((w) => w.type === "cycling");
    expect(cycling.length).toBeGreaterThan(0);
    for (const ride of cycling) {
      expect(ride.intensity).toBe("easy");
    }
  });

  it("fills non-quality cycling days with easy Zone 2, never moderate (80/20 base)", () => {
    const result = schedule(
      makeInput({
        trainingLoad: { ctl: 50, atl: 60, tsb: -10 },
      }),
    );
    const cycling = result.filter((w) => w.type === "cycling");
    expect(cycling.length).toBeGreaterThan(0);
    for (const ride of cycling) {
      expect(ride.intensity).toBe("easy");
    }
  });

  it("degrades gracefully when most days are locked", () => {
    // Only dates[1] and dates[3] open; algorithm must not crash and must
    // return only what fits (no duplicate placements, no events on locked dates).
    const existing: IntervalsEvent[] = [
      "2026-04-20",
      "2026-04-22",
      "2026-04-24",
      "2026-04-25",
      "2026-04-26",
    ].map((d, i) => ({
      id: i + 1,
      start_date_local: d,
      name: "Existing",
      category: "WORKOUT",
      type: "Ride",
    }));

    const result = schedule(makeInput({ existingEvents: existing }));

    const distinctDates = new Set(result.map((w) => w.date));
    expect(distinctDates.size).toBeLessThanOrEqual(2);
    for (const w of result) {
      expect(["2026-04-21", "2026-04-23"]).toContain(w.date);
    }
  });

  describe("weights co-location (polarized stacking)", () => {
    const freshLoad = { ctl: 50, atl: 40, tsb: 10 };

    it("co-locates at least one weights session with the sweet-spot day", () => {
      const result = schedule(makeInput());
      const lcDate = result.find((w) => w.type === "sweet_spot")?.date;
      const weightDates = new Set(result.filter((w) => w.type === "weights").map((w) => w.date));
      expect(lcDate).toBeDefined();
      expect(weightDates.has(lcDate!)).toBe(true);
    });

    it("places cycling before weights on the same date", () => {
      const result = schedule(makeInput({ trainingLoad: freshLoad }));
      // Find a date with both cycling (any intensity) and weights
      const byDate = new Map<string, PlannedWorkout[]>();
      for (const w of result) {
        const arr = byDate.get(w.date) ?? [];
        arr.push(w);
        byDate.set(w.date, arr);
      }
      let checked = 0;
      for (const [, entries] of byDate) {
        const cyclingTypes = new Set(["cycling", "sweet_spot"]);
        const hasCycling = entries.some((w) => cyclingTypes.has(w.type));
        const hasWeights = entries.some((w) => w.type === "weights");
        if (hasCycling && hasWeights) {
          const cyclingIdx = entries.findIndex((w) => cyclingTypes.has(w.type));
          const weightsIdx = entries.findIndex((w) => w.type === "weights");
          expect(cyclingIdx).toBeLessThan(weightsIdx);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it("when fresh, both weights sessions land on hard-training days", () => {
      const result = schedule(makeInput({ trainingLoad: freshLoad }));
      const weightDates = result.filter((w) => w.type === "weights").map((w) => w.date);
      expect(weightDates).toHaveLength(2);
      for (const d of weightDates) {
        const sameDay = result.filter((w) => w.date === d);
        const hasHardPartner = sameDay.some((w) => w.type !== "weights" && isHardEntry(w));
        expect(hasHardPartner).toBe(true);
      }
    });
  });

  describe("very fatigued (TSB below tsb_very_fatigued)", () => {
    const veryFatiguedLoad = { ctl: 56, atl: 86, tsb: -30 };

    it("drops the sweet-spot session entirely", () => {
      const result = schedule(makeInput({ trainingLoad: veryFatiguedLoad }));
      expect(result.filter((w) => w.type === "sweet_spot")).toHaveLength(0);
    });

    it("reduces weight sessions to weight_sessions_very_fatigued", () => {
      const result = schedule(makeInput({ trainingLoad: veryFatiguedLoad }));
      expect(result.filter((w) => w.type === "weights")).toHaveLength(1);
    });

    it("keeps all cycling at easy intensity", () => {
      const result = schedule(makeInput({ trainingLoad: veryFatiguedLoad }));
      const cycling = result.filter((w) => w.type === "cycling");
      for (const ride of cycling) {
        expect(ride.intensity).toBe("easy");
      }
    });

    it("places rest on day 0 (starts the week with recovery)", () => {
      const result = schedule(makeInput({ trainingLoad: veryFatiguedLoad }));
      const day0 = result.find((w) => w.date === "2026-04-20");
      expect(day0?.type).toBe("rest");
    });

    it("places the weights session mid-week, not on day 0 or 1", () => {
      const result = schedule(makeInput({ trainingLoad: veryFatiguedLoad }));
      const weightsDay = result.find((w) => w.type === "weights")?.date;
      expect(weightsDay).toBeDefined();
      expect(["2026-04-22", "2026-04-23", "2026-04-24"]).toContain(weightsDay!);
    });

    it("adds a second rest day after the weights session", () => {
      const result = schedule(makeInput({ trainingLoad: veryFatiguedLoad }));
      const rests = result.filter((w) => w.type === "rest");
      expect(rests.length).toBeGreaterThanOrEqual(2);
      const weightsIdx = result.findIndex((w) => w.type === "weights");
      expect(weightsIdx).toBeGreaterThan(0);
      expect(result[weightsIdx + 1]?.type).toBe("rest");
    });

    it("skips the priority day-0 rest if day 0 is already locked", () => {
      const existing: IntervalsEvent[] = [
        {
          id: 1,
          start_date_local: "2026-04-20",
          name: "Locked Ride",
          category: "WORKOUT",
          type: "Ride",
        },
      ];
      const result = schedule(
        makeInput({ trainingLoad: veryFatiguedLoad, existingEvents: existing }),
      );
      expect(result.find((w) => w.date === "2026-04-20")).toBeUndefined();
      expect(result.filter((w) => w.type === "weights")).toHaveLength(1);
    });
  });

  describe("completed-activity awareness", () => {
    it("locks dates that already have a completed activity (not just calendar events)", () => {
      // Already trained today (e.g. a ride logged as an activity, not a planned
      // calendar event). The scheduler must not pile another session on it.
      const result = schedule(makeInput({ completedDates: ["2026-04-20"] }));
      expect(result.find((w) => w.date === "2026-04-20")).toBeUndefined();
    });

    it("locks completed dates in addition to existing calendar events", () => {
      const existing: IntervalsEvent[] = [
        {
          id: 1,
          start_date_local: "2026-04-21",
          name: "Group Ride",
          category: "WORKOUT",
          type: "Ride",
        },
      ];
      const result = schedule(
        makeInput({ existingEvents: existing, completedDates: ["2026-04-20"] }),
      );
      expect(result.find((w) => w.date === "2026-04-20")).toBeUndefined();
      expect(result.find((w) => w.date === "2026-04-21")).toBeUndefined();
    });
  });

  describe("no hard stacking on recovery weeks", () => {
    const fatiguedLoad = { ctl: 50, atl: 70, tsb: -15 };

    it("does not co-locate weights on the sweet-spot day when fatigued", () => {
      const result = schedule(makeInput({ trainingLoad: fatiguedLoad }));
      const lcDate = result.find((w) => w.type === "sweet_spot")?.date;
      expect(lcDate).toBeDefined();
      const sameDay = result.filter((w) => w.date === lcDate);
      expect(sameDay.some((w) => w.type === "weights")).toBe(false);
    });

    it("never places two hard sessions on the same day when fatigued", () => {
      const result = schedule(makeInput({ trainingLoad: fatiguedLoad }));
      const byDate = new Map<string, number>();
      for (const w of result) {
        if (isHardEntry(w)) byDate.set(w.date, (byDate.get(w.date) ?? 0) + 1);
      }
      for (const [, count] of byDate) {
        expect(count).toBeLessThanOrEqual(1);
      }
    });

    it("still places both weight sessions when fatigued", () => {
      const result = schedule(makeInput({ trainingLoad: fatiguedLoad }));
      expect(result.filter((w) => w.type === "weights")).toHaveLength(2);
    });
  });

  describe("ramp guard", () => {
    const freshLoad = { ctl: 50, atl: 40, tsb: 10 };

    it("does not fire when rampRatePct is undefined", () => {
      const result = schedule(makeInput({ trainingLoad: freshLoad }));
      const hardRides = result.filter((w) => w.type === "cycling" && w.intensity === "hard");
      expect(hardRides.length).toBeGreaterThan(0);
    });

    it("does not fire when rampRatePct is at or below threshold", () => {
      const result = schedule(makeInput({ trainingLoad: freshLoad, rampRatePct: 7 }));
      const hardRides = result.filter((w) => w.type === "cycling" && w.intensity === "hard");
      expect(hardRides.length).toBeGreaterThan(0);
    });

    it("downgrades all hard cycling to non-hard when ramp exceeds threshold", () => {
      const result = schedule(makeInput({ trainingLoad: freshLoad, rampRatePct: 9.5 }));
      const cycling = result.filter((w) => w.type === "cycling");
      expect(cycling.length).toBeGreaterThan(0);
      for (const ride of cycling) {
        expect(ride.intensity).not.toBe("hard");
      }
    });

    it("still places weight + sweet-spot sessions when guard fires", () => {
      const result = schedule(makeInput({ trainingLoad: freshLoad, rampRatePct: 9.5 }));
      // Guard only affects cycling intensity, not strength/sweet-spot cadence.
      expect(result.filter((w) => w.type === "sweet_spot")).toHaveLength(1);
      expect(result.filter((w) => w.type === "weights")).toHaveLength(2);
    });
  });

  describe("readiness downgrade", () => {
    const freshLoad = { ctl: 50, atl: 40, tsb: 12 }; // fresh

    it("drops hard cycling to non-hard when readiness is suppressed on a fresh week", () => {
      const baseline = schedule(makeInput({ trainingLoad: freshLoad }));
      expect(baseline.some((w) => w.type === "cycling" && w.intensity === "hard")).toBe(true);

      const suppressed = schedule(
        makeInput({ trainingLoad: freshLoad, readiness: { status: "suppressed" } }),
      );
      for (const ride of suppressed.filter((w) => w.type === "cycling")) {
        expect(ride.intensity).not.toBe("hard");
      }
    });

    it("does not change the week when readiness is normal", () => {
      const normal = schedule(
        makeInput({ trainingLoad: freshLoad, readiness: { status: "normal" } }),
      );
      expect(normal.some((w) => w.type === "cycling" && w.intensity === "hard")).toBe(true);
    });

    it("never deepens into the very_fatigued protocol from readiness alone", () => {
      // fatigued TSB downgraded by readiness stays fatigued (floor), so a
      // sweet-spot session is still scheduled rather than dropped.
      const fatiguedLoad = { ctl: 50, atl: 65, tsb: -15 };
      const result = schedule(
        makeInput({ trainingLoad: fatiguedLoad, readiness: { status: "suppressed" } }),
      );
      expect(result.filter((w) => w.type === "sweet_spot")).toHaveLength(1);
    });

    it("does not stack with the ramp guard — a suppressed fresh+ramp week equals a plain moderate week", () => {
      // fresh TSB → suppressed downgrades to moderate; classifyIntensity is then
      // "moderate", so the ramp guard's `baseIntensity === "hard"` check is
      // already false. The two guards must not compound into something harsher
      // than a normal moderate week.
      const suppressedFreshRamp = schedule(
        makeInput({
          trainingLoad: freshLoad,
          readiness: { status: "suppressed" },
          rampRatePct: 9.5,
        }),
      );
      const plainModerate = schedule(makeInput({ trainingLoad: { ctl: 50, atl: 50, tsb: 0 } }));
      expect(suppressedFreshRamp).toEqual(plainModerate);
      expect(suppressedFreshRamp.some((w) => w.type === "cycling" && w.intensity === "hard")).toBe(
        false,
      );
    });

    it("leaves a very_fatigued week's plan byte-for-byte unchanged when suppressed", () => {
      // very_fatigued is already the floor: a suppressed signal must not deepen
      // the protocol. The whole plan (day-0 rest, single weights, no sweet-spot,
      // all-easy cycling) should match the no-readiness baseline exactly.
      const veryFatiguedLoad = { ctl: 50, atl: 75, tsb: -25 };
      const base = schedule(makeInput({ trainingLoad: veryFatiguedLoad }));
      const suppressed = schedule(
        makeInput({ trainingLoad: veryFatiguedLoad, readiness: { status: "suppressed" } }),
      );
      expect(suppressed).toEqual(base);
      // And sanity-check the very_fatigued shape itself.
      expect(suppressed[0].type).toBe("rest");
      expect(suppressed.filter((w) => w.type === "sweet_spot")).toHaveLength(0);
      expect(suppressed.filter((w) => w.type === "weights")).toHaveLength(1);
    });
  });

  describe("downgradeOneTier", () => {
    it("steps fresh→moderate and moderate→fatigued", () => {
      expect(downgradeOneTier("fresh")).toBe("moderate");
      expect(downgradeOneTier("moderate")).toBe("fatigued");
    });
    it("floors at fatigued — fatigued and very_fatigued are unchanged", () => {
      expect(downgradeOneTier("fatigued")).toBe("fatigued");
      expect(downgradeOneTier("very_fatigued")).toBe("very_fatigued");
    });
  });

  describe("rampGuardTriggered", () => {
    it("returns false for undefined or below-threshold values", () => {
      expect(rampGuardTriggered(undefined, BASE_CONFIG)).toBe(false);
      expect(rampGuardTriggered(0, BASE_CONFIG)).toBe(false);
      expect(rampGuardTriggered(7, BASE_CONFIG)).toBe(false);
    });
    it("returns true when ramp exceeds threshold", () => {
      expect(rampGuardTriggered(7.1, BASE_CONFIG)).toBe(true);
      expect(rampGuardTriggered(15, BASE_CONFIG)).toBe(true);
    });
  });

  describe("classifyFatigue", () => {
    const cfg = BASE_CONFIG;
    it("returns very_fatigued below tsb_very_fatigued", () => {
      expect(classifyFatigue(-25, cfg)).toBe("very_fatigued");
    });
    it("returns fatigued between tsb_very_fatigued and tsb_fatigued", () => {
      expect(classifyFatigue(-15, cfg)).toBe("fatigued");
    });
    it("returns moderate between tsb_fatigued and tsb_fresh", () => {
      expect(classifyFatigue(0, cfg)).toBe("moderate");
    });
    it("returns fresh above tsb_fresh", () => {
      expect(classifyFatigue(10, cfg)).toBe("fresh");
    });
  });

  describe("zone-aware hard-day placement", () => {
    const freshLoad = { ctl: 50, atl: 40, tsb: 10 };

    it("attaches a targetZone to every hard cycling ride when distribution is given", () => {
      // Distribution shows endurance over-represented, hard zones empty —
      // every hard cycling target should pick a hard zone.
      const dist = { ...emptyDistribution(), endurance: 1.0 };
      const result = schedule(makeInput({ trainingLoad: freshLoad, zoneDistribution: dist }));
      const hardRides = result.filter((w) => w.type === "cycling" && w.intensity === "hard");
      expect(hardRides.length).toBeGreaterThan(0);
      for (const ride of hardRides) {
        expect(ride.targetZone).toBeDefined();
        expect(["sweet_spot", "threshold", "vo2", "anaerobic"]).toContain(ride.targetZone);
      }
    });

    it("does not assign duplicate zones across multiple hard rides", () => {
      const dist = { ...emptyDistribution(), endurance: 1.0 };
      // The default 80/20 cap is 1 hard cycling day; raise it to 2 here so the
      // multi-hard-ride zone-distinctness behavior is exercised. A real build
      // block is where you'd bump hard_cycling_days like this.
      const cfg: Config = {
        ...BASE_CONFIG,
        scheduling: { ...BASE_CONFIG.scheduling, hard_cycling_days: 2 },
      };
      const result = schedule(
        makeInput({ trainingLoad: freshLoad, zoneDistribution: dist, config: cfg }),
      );
      const zones = result
        .filter((w) => w.type === "cycling" && w.intensity === "hard")
        .map((w) => w.targetZone);
      // Cardinal: at least 2 hard rides with distinct zones when fresh
      expect(zones.length).toBeGreaterThanOrEqual(2);
      expect(new Set(zones).size).toBe(zones.length);
    });

    it("omits targetZone when no distribution is supplied (back-compat)", () => {
      const result = schedule(makeInput({ trainingLoad: freshLoad }));
      const hardRides = result.filter((w) => w.type === "cycling" && w.intensity === "hard");
      for (const ride of hardRides) {
        expect(ride.targetZone).toBeUndefined();
      }
    });

    it("does not attach a targetZone to easy or moderate rides", () => {
      const dist = { ...emptyDistribution(), endurance: 1.0 };
      const result = schedule(
        makeInput({
          trainingLoad: { ctl: 50, atl: 70, tsb: -15 }, // fatigued → easy
          zoneDistribution: dist,
        }),
      );
      const cycling = result.filter((w) => w.type === "cycling");
      expect(cycling.length).toBeGreaterThan(0);
      for (const ride of cycling) {
        expect(ride.targetZone).toBeUndefined();
      }
    });
  });

  it("uses wotd_name for hard rides when provided", () => {
    const result = schedule(
      makeInput({
        trainingLoad: { ctl: 50, atl: 40, tsb: 10 },
        xertInfo: {
          ftp: 250,
          ltp: 210,
          hie: 22,
          pp: 1100,
          training_status: "Fresh",
          focus: "Endurance",
          wotd_name: "SMART Workout 42",
          wotd_description: "4x4min VO2max",
        },
      }),
    );
    const hardRides = result.filter((w) => w.type === "cycling" && w.intensity === "hard");
    expect(hardRides.length).toBeGreaterThan(0);
    for (const ride of hardRides) {
      expect(ride.name).toBe("SMART Workout 42");
      expect(ride.description).toContain("SMART Workout 42");
      expect(ride.description).toContain("4x4min VO2max");
    }
  });

  describe("classifyPhase / phaseWeightSessions", () => {
    it("returns undefined when weeksToRace is undefined", () => {
      expect(classifyPhase(undefined, BASE_CONFIG)).toBeUndefined();
      expect(phaseWeightSessions(undefined, undefined, BASE_CONFIG)).toBe(2);
    });

    it("classifies block at or beyond taper_weeks", () => {
      expect(classifyPhase(4, BASE_CONFIG)).toBe("block");
      expect(classifyPhase(12, BASE_CONFIG)).toBe("block");
      expect(phaseWeightSessions("block", 12, BASE_CONFIG)).toBe(2);
    });

    it("classifies taper below taper_weeks", () => {
      expect(classifyPhase(3, BASE_CONFIG)).toBe("taper");
      expect(phaseWeightSessions("taper", 3, BASE_CONFIG)).toBe(1);
    });

    it("returns zero sessions in the final taper week", () => {
      expect(classifyPhase(0, BASE_CONFIG)).toBe("taper");
      expect(phaseWeightSessions("taper", 0, BASE_CONFIG)).toBe(0);
    });
  });

  describe("periodized strength scheduling", () => {
    const taperConfig: Config = {
      ...BASE_CONFIG,
      weight_training_taper: {
        name: "Taper Lift",
        duration_minutes: 30,
        description: "Squat + deadlift, low volume",
      },
    };

    it("uses the block routine and full session count when far from the race", () => {
      const plan = schedule(makeInput({ config: taperConfig, weeksToRace: 12 }));
      const weights = plan.filter((w) => w.type === "weights");
      expect(weights.length).toBe(2);
      expect(weights.every((w) => w.name === "Strength")).toBe(true);
      expect(weights.every((w) => w.durationMin === 60)).toBe(true);
    });

    it("uses the taper routine and one session inside the taper window", () => {
      const plan = schedule(makeInput({ config: taperConfig, weeksToRace: 3 }));
      const weights = plan.filter((w) => w.type === "weights");
      expect(weights.length).toBe(1);
      expect(weights[0].name).toBe("Taper Lift");
      expect(weights[0].durationMin).toBe(30);
    });

    it("places no strength in the final taper week", () => {
      const plan = schedule(makeInput({ config: taperConfig, weeksToRace: 0 }));
      expect(plan.filter((w) => w.type === "weights").length).toBe(0);
    });

    it("falls back to the block routine when no taper variant is defined", () => {
      const plan = schedule(makeInput({ config: BASE_CONFIG, weeksToRace: 3 }));
      const weights = plan.filter((w) => w.type === "weights");
      expect(weights.length).toBe(1);
      expect(weights[0].name).toBe("Strength");
      expect(weights[0].durationMin).toBe(60);
    });

    it("is unchanged when weeksToRace is undefined (backward compat)", () => {
      const plan = schedule(makeInput({ config: BASE_CONFIG }));
      expect(plan.filter((w) => w.type === "weights").length).toBe(2);
    });

    it("lets very-fatigued cap the block phase below its phase count", () => {
      // block asks for 2; very-fatigued caps at weight_sessions_very_fatigued (1).
      // Effective count is min(2, 1) = 1, and the block routine is still used.
      const plan = schedule(
        makeInput({
          config: taperConfig,
          weeksToRace: 12,
          trainingLoad: { ctl: 56, atl: 86, tsb: -30 },
        }),
      );
      const weights = plan.filter((w) => w.type === "weights");
      expect(weights.length).toBe(1);
      expect(weights[0].name).toBe("Strength");
    });
  });

  describe("planned-load targets", () => {
    it("attaches TSS, duration, and IF to every non-rest workout", () => {
      const result = schedule(makeInput({ trainingLoad: { ctl: 50, atl: 40, tsb: 10 } }));
      for (const w of result) {
        if (w.type === "rest") continue;
        expect(typeof w.durationMin).toBe("number");
        if (w.type === "weights") {
          // Weights carry duration only — no TSS/IF (matches Intervals.icu).
          expect(w.load).toBeUndefined();
          expect(w.intensityFactor).toBeUndefined();
        } else {
          expect(typeof w.load).toBe("number");
          expect(typeof w.intensityFactor).toBe("number");
        }
      }
    });

    it("computes sweet-spot TSS from its duration and sweet_spot_if", () => {
      const result = schedule(makeInput());
      const ss = result.find((w) => w.type === "sweet_spot");
      expect(ss).toBeDefined();
      // 60 min @ IF 0.88 → (60/60) * 0.88^2 * 100 = 77.44 → 77
      expect(ss!.durationMin).toBe(60);
      expect(ss!.intensityFactor).toBe(0.88);
      expect(ss!.load).toBe(77);
    });

    it("promotes exactly one easy ride to the weekly long endurance ride", () => {
      const result = schedule(makeInput());
      const longRides = result.filter((w) => w.name === "Long Endurance Ride");
      expect(longRides).toHaveLength(1);
      expect(longRides[0].durationMin).toBe(180);
      expect(longRides[0].intensity).toBe("easy");
      // 180 min @ IF 0.62 → 3 * 0.3844 * 100 = 115.3 → 115
      expect(longRides[0].load).toBe(115);
    });

    it("gives weights a duration target but no TSS", () => {
      const result = schedule(makeInput());
      const weights = result.filter((w) => w.type === "weights");
      expect(weights.length).toBeGreaterThan(0);
      for (const w of weights) {
        expect(w.durationMin).toBe(60);
        expect(w.load).toBeUndefined();
      }
    });
  });

  describe("existing-event constraint seeding", () => {
    // Locked days must not be invisible: events already on the calendar count
    // toward the sweet-spot quota, back-to-back hard spacing, and the weekly
    // weight-session count/gap.
    const ev = (
      date: string,
      name: string,
      type = "Ride",
      extra: Partial<IntervalsEvent> = {},
    ): IntervalsEvent => ({
      id: 1,
      start_date_local: `${date}T00:00:00`,
      name,
      category: "WORKOUT",
      type,
      ...extra,
    });
    const freshLoad = { ctl: 50, atl: 40, tsb: 10 };

    it("an existing sweet-spot event suppresses the planner's own sweet-spot", () => {
      const result = schedule(
        makeInput({ existingEvents: [ev("2026-04-24", "Sweet Spot Intervals")] }),
      );
      expect(result.filter((w) => w.type === "sweet_spot")).toHaveLength(0);
    });

    it("an existing hard event blocks hard placement on adjacent days and fills the hard-ride quota", () => {
      // Hard interval ride already on Thu (idx 3): Wed and Fri must stay easy,
      // and the existing ride consumes the hard_cycling_days budget (1).
      const result = schedule(
        makeInput({
          trainingLoad: freshLoad,
          existingEvents: [ev("2026-04-23", "VO2max Intervals")],
        }),
      );
      const hardOn = (date: string) => result.filter((w) => w.date === date && isHardEntry(w));
      expect(hardOn("2026-04-22")).toHaveLength(0);
      expect(hardOn("2026-04-24")).toHaveLength(0);
      const hardRides = result.filter((w) => w.type === "cycling" && w.intensity === "hard");
      expect(hardRides).toHaveLength(0);
    });

    it("existing weight sessions count toward weight_sessions", () => {
      const result = schedule(
        makeInput({
          existingEvents: [
            ev("2026-04-21", "Cyclist Strength Routine", "WeightTraining"),
            ev("2026-04-25", "Cyclist Strength Routine", "WeightTraining"),
          ],
        }),
      );
      expect(result.filter((w) => w.type === "weights")).toHaveLength(0);
    });

    it("a new weight session honors min_weight_gap_days from an existing one", () => {
      const result = schedule(
        makeInput({
          existingEvents: [ev("2026-04-22", "Cyclist Strength Routine", "WeightTraining")],
        }),
      );
      const weights = result.filter((w) => w.type === "weights");
      expect(weights).toHaveLength(1); // quota 2, one already on the calendar
      // ≥ 2 days from the existing Wed session → not Tue/Wed/Thu.
      expect(["2026-04-21", "2026-04-22", "2026-04-23"]).not.toContain(weights[0].date);
    });

    it("a hard event the day before the window blocks day-0 hard placement", () => {
      const result = schedule(
        makeInput({
          trainingLoad: freshLoad,
          existingEvents: [ev("2026-04-19", "Sweet Spot Intervals")],
        }),
      );
      const day0 = result.filter((w) => w.date === "2026-04-20");
      expect(day0.length).toBeGreaterThan(0); // day 0 isn't locked, just kept easy
      expect(day0.filter(isHardEntry)).toHaveLength(0);
      // Pre-window events don't consume this week's quota.
      expect(result.filter((w) => w.type === "sweet_spot")).toHaveLength(1);
    });

    it("a weight session just before the window pushes this week's first one out, without consuming quota", () => {
      const result = schedule(
        makeInput({
          existingEvents: [ev("2026-04-19", "Cyclist Strength Routine", "WeightTraining")],
        }),
      );
      const weights = result.filter((w) => w.type === "weights");
      expect(weights).toHaveLength(2);
      expect(weights.map((w) => w.date)).not.toContain("2026-04-20");
    });

    it("an existing long endurance ride suppresses promoting a second one", () => {
      // A long ride already on the calendar (Mon, idx 1) must stop the planner
      // from promoting one of its own easy rides to a second long ride.
      const result = schedule(
        makeInput({
          existingEvents: [
            ev("2026-04-21", "Long Endurance Ride", "Ride", { icu_intensity: 0.62 }),
          ],
        }),
      );
      expect(result.filter((w) => w.name === "Long Endurance Ride")).toHaveLength(0);
      // The would-be long ride stays a normal easy ride at the standard duration.
      const easyRides = result.filter((w) => w.type === "cycling" && w.intensity === "easy");
      expect(easyRides.length).toBeGreaterThan(0);
      for (const w of easyRides) expect(w.durationMin).toBe(BASE_CONFIG.load_targets.easy_minutes);
    });

    it("a name merely containing 'long' as a substring does not suppress promotion", () => {
      // "Prolonged" contains "long" but isn't a long ride — the word-boundary
      // regex must not let it suppress the weekly promotion.
      const result = schedule(
        makeInput({
          existingEvents: [ev("2026-04-21", "Prolonged Effort", "Ride", { icu_intensity: 0.62 })],
        }),
      );
      expect(result.filter((w) => w.name === "Long Endurance Ride")).toHaveLength(1);
    });

    it("a long ride before the window does not suppress this week's promotion", () => {
      // Pre-window long ride (idx -1) belongs to last week; this week still gets
      // its own promoted long ride.
      const result = schedule(
        makeInput({
          existingEvents: [
            ev("2026-04-19", "Long Endurance Ride", "Ride", { icu_intensity: 0.62 }),
          ],
        }),
      );
      expect(result.filter((w) => w.name === "Long Endurance Ride")).toHaveLength(1);
    });

    it("existing easy rides lock their day but block nothing else", () => {
      const result = schedule(
        makeInput({
          existingEvents: [ev("2026-04-23", "Easy Ride", "Ride", { icu_intensity: 0.62 })],
        }),
      );
      expect(result.filter((w) => w.type === "sweet_spot")).toHaveLength(1);
      expect(result.filter((w) => w.type === "weights")).toHaveLength(2);
    });

    it("regression 2026-06-11: does not stack a hard day between existing strength and sweet-spot events", () => {
      // Observed failure: calendar held Strength Wed 6/10, Sweet Spot Fri 6/12,
      // Strength Sun 6/14 — the planner proposed Sweet Spot + Strength on Thu
      // 6/11, creating three consecutive hard days, a second weekly sweet-spot,
      // and a third weekly strength session.
      const result = schedule(
        makeInput({
          startDate: "2026-06-11",
          existingEvents: [
            ev("2026-06-10", "Cyclist Strength Routine", "WeightTraining"),
            ev("2026-06-12", "Sweet Spot Intervals"),
            ev("2026-06-14", "Cyclist Strength Routine", "WeightTraining"),
          ],
        }),
      );
      // Thu 6/11 sits between two existing hard days — nothing hard goes there.
      expect(result.filter((w) => w.date === "2026-06-11" && isHardEntry(w))).toHaveLength(0);
      // The Fri sweet-spot fills the weekly quota.
      expect(result.filter((w) => w.type === "sweet_spot")).toHaveLength(0);
      // Sun's strength counts toward weight_sessions (2) — at most one more,
      // spaced ≥ min_weight_gap_days from 6/14 and clear of adjacent hard days.
      const weights = result.filter((w) => w.type === "weights");
      expect(weights.length).toBeLessThanOrEqual(1);
      for (const w of weights) {
        expect(["2026-06-16", "2026-06-17"]).toContain(w.date);
      }
      // No back-to-back hard days across existing + planned events combined.
      const hardDates = [
        "2026-06-10",
        "2026-06-12",
        "2026-06-14",
        ...result.filter(isHardEntry).map((w) => w.date),
      ];
      const sorted = [...new Set(hardDates)].sort();
      for (let i = 1; i < sorted.length; i++) {
        const diff =
          (new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / 86_400_000;
        expect(diff).toBeGreaterThanOrEqual(2);
      }
    });
  });
});

describe("classifyExistingEvent", () => {
  const ev = (overrides: Partial<IntervalsEvent>): IntervalsEvent => ({
    start_date_local: "2026-04-20T00:00:00",
    name: "Workout",
    category: "WORKOUT",
    ...overrides,
  });

  it("classifies WeightTraining type and strength-named events as weights", () => {
    expect(classifyExistingEvent(ev({ type: "WeightTraining", name: "Lift" }))).toBe("weights");
    expect(classifyExistingEvent(ev({ type: "Ride", name: "Cyclist Strength Routine" }))).toBe(
      "weights",
    );
  });

  it("classifies sweet-spot by name (before the generic interval pattern)", () => {
    expect(classifyExistingEvent(ev({ name: "Sweet Spot Intervals" }))).toBe("sweet_spot");
  });

  it("classifies hard interval names as hard_cycling", () => {
    expect(classifyExistingEvent(ev({ name: "VO2max Repeats" }))).toBe("hard_cycling");
    expect(classifyExistingEvent(ev({ name: "Threshold 2x20" }))).toBe("hard_cycling");
  });

  it("classifies races as hard_cycling", () => {
    expect(classifyExistingEvent(ev({ category: "RACE_A", name: "Gravel Century" }))).toBe(
      "hard_cycling",
    );
  });

  it("classifies easy/endurance/long names as easy", () => {
    expect(classifyExistingEvent(ev({ name: "Easy Ride" }))).toBe("easy");
    expect(classifyExistingEvent(ev({ name: "Long Endurance Ride" }))).toBe("easy");
  });

  it("falls back to planned IF for arbitrary names", () => {
    expect(classifyExistingEvent(ev({ name: "Iron Lung", icu_intensity: 0.98 }))).toBe(
      "hard_cycling",
    );
    expect(classifyExistingEvent(ev({ name: "SS 2x20", icu_intensity: 0.88 }))).toBe("sweet_spot");
    expect(classifyExistingEvent(ev({ name: "Coffee Spin", icu_intensity: 0.6 }))).toBe("easy");
  });

  it("treats notes and unrecognized events as other", () => {
    expect(classifyExistingEvent(ev({ category: "NOTE", name: "Rest Day" }))).toBe("other");
    expect(classifyExistingEvent(ev({ name: "Group Ride" }))).toBe("other");
  });
});
