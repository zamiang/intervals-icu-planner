import { describe, it, expect } from "vitest";
import {
  schedule,
  classifyFatigue,
  rampGuardTriggered,
  classifyPhase,
  phaseWeightSessions,
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
});
