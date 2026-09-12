import { describe, it, expect } from "vitest";
import {
  ageOn,
  carbRate,
  fuelNoteDescription,
  fuelNoteEvents,
  fuelNoteName,
  fuelTargetsFor,
  isWithinBlock,
  latestWeightKg,
  restingMetabolicRate,
  isRide,
  sessionKcal,
} from "../src/fueling.js";
import type { FuelingConfig, PlannedWorkout } from "../src/types.js";

const CFG: FuelingConfig = {
  enabled: true,
  start_date: null,
  end_date: null,
  daily_deficit_kcal: 550,
  fuel_day_addback_kcal: 400,
  deficit_day_extra_kcal: 150,
  min_kcal: 1800,
  protein_g_per_kg: 2.2,
  fat_g_per_kg: 0.8,
  non_exercise_multiplier: 1.35,
  weights_kcal_per_hour: 300,
  avg_power_factor: 0.9,
  low_carb_max_minutes: 90,
  hard_min_if: 0.75,
  long_min_minutes: 150,
  hard_carb_g_per_hour: [30, 60],
  moderate_carb_g_per_hour: [60, 75],
  long_carb_g_per_hour: [60, 90],
};

// The athlete this was built for, so the numbers below are the real ones.
const ATHLETE = { weightKg: 75, heightCm: 180, ageYears: 40, sex: "M" as const, ftp: 250 };

function workout(overrides: Partial<PlannedWorkout>): PlannedWorkout {
  return {
    date: "2026-09-28",
    type: "cycling",
    name: "Easy Ride",
    description: "",
    intensity: "easy",
    durationMin: 75,
    intensityFactor: 0.62,
    ...overrides,
  };
}

describe("restingMetabolicRate", () => {
  it("matches Mifflin-St Jeor for the athlete", () => {
    // 10(75) + 6.25(180) - 5(40) + 5
    expect(restingMetabolicRate(75, 180, 40, "M")).toBeCloseTo(1680, 2);
  });
});

describe("isRide", () => {
  it("counts the two ride types and nothing else", () => {
    expect(isRide("cycling")).toBe(true);
    expect(isRide("sweet_spot")).toBe(true);
    expect(isRide("weights")).toBe(false);
    expect(isRide("rest")).toBe(false);
    expect(isRide("travel")).toBe(false);
  });
});

describe("sessionKcal", () => {
  it("estimates ride energy from planned IF and duration", () => {
    // avg watts = 0.62 * 250 * 0.9 = 139.5; 139.5 W * 10800 s = 1506.6 kJ ~ 1507 kcal
    expect(sessionKcal(workout({ durationMin: 180 }), 250, CFG)).toBe(1507);
  });

  it("uses a flat hourly rate for strength, which has no power model", () => {
    const w = workout({ type: "weights", durationMin: 60, intensityFactor: undefined });
    expect(sessionKcal(w, 250, CFG)).toBe(300);
  });

  it("is zero for rest, travel, and sessions missing duration or intensity", () => {
    expect(sessionKcal(workout({ type: "rest" }), 250, CFG)).toBe(0);
    expect(sessionKcal(workout({ type: "travel" }), 250, CFG)).toBe(0);
    expect(sessionKcal(workout({ durationMin: undefined }), 250, CFG)).toBe(0);
    expect(sessionKcal(workout({ intensityFactor: undefined }), 250, CFG)).toBe(0);
  });
});

describe("carbRate", () => {
  it("fuels a long ride fully even when it is easy — duration empties glycogen, not intensity", () => {
    expect(carbRate(180, 0.62, CFG)).toEqual({ loGPerHour: 60, hiGPerHour: 90 });
  });

  it("fuels a short quality session, because carb availability sets interval quality", () => {
    expect(carbRate(60, 0.88, CFG)).toEqual({ loGPerHour: 30, hiGPerHour: 60 });
  });

  it("leaves a short easy ride unfuelled — the one place the deficit is free", () => {
    expect(carbRate(75, 0.62, CFG)).toBeNull();
  });

  it("fuels a mid-length easy ride past the low-carb ceiling", () => {
    expect(carbRate(120, 0.62, CFG)).toEqual({ loGPerHour: 60, hiGPerHour: 75 });
  });

  it("returns null when nothing is ridden", () => {
    expect(carbRate(0, null, CFG)).toBeNull();
  });

  it("prefers the long band over the hard band when a ride is both", () => {
    expect(carbRate(180, 0.88, CFG)).toEqual({ loGPerHour: 60, hiGPerHour: 90 });
  });
});

describe("fuelTargetsFor", () => {
  const day = (workouts: PlannedWorkout[]) =>
    fuelTargetsFor({ date: "2026-09-28", workouts, ...ATHLETE }, CFG);

  it("holds protein and fat constant and lets carbohydrate absorb the difference", () => {
    const rest = day([workout({ type: "rest", durationMin: undefined })]);
    const long = day([workout({ durationMin: 180 })]);
    expect(rest.proteinG).toBe(long.proteinG);
    expect(rest.fatG).toBe(long.fatG);
    expect(long.carbG).toBeGreaterThan(rest.carbG);
  });

  it("sets protein and fat from body weight", () => {
    const t = day([workout({})]);
    expect(t.proteinG).toBe(165); // 2.2 * 75
    expect(t.fatG).toBe(60); // 0.8 * 75
  });

  it("treats a long ride as a fuel day and pulls it back toward maintenance", () => {
    const t = day([workout({ durationMin: 180 })]);
    expect(t.isFuelDay).toBe(true);
    // base 1680 * 1.35 = 2268, + 1507 exercise
    expect(t.maintenanceKcal).toBe(3775);
    expect(t.kcal).toBe(3775 - (550 - 400));
  });

  it("treats a short easy day as a deficit day and takes the extra", () => {
    const t = day([workout({ durationMin: 75 })]);
    expect(t.isFuelDay).toBe(false);
    expect(t.maintenanceKcal - t.kcal).toBe(550 + 150);
  });

  it("counts a quality session as a fuel day regardless of length", () => {
    const t = day([workout({ type: "sweet_spot", durationMin: 60, intensityFactor: 0.88 })]);
    expect(t.isFuelDay).toBe(true);
  });

  it("sums stacked sessions on one day", () => {
    const t = day([
      workout({ durationMin: 75 }),
      workout({ type: "weights", durationMin: 60, intensityFactor: undefined }),
    ]);
    // 0.62 * 250 * 0.9 = 139.5 W over 75 min = 628 kcal, plus 300 for strength
    expect(t.exerciseKcal).toBe(928);
  });

  it("never prescribes below the floor, even when the arithmetic says to", () => {
    const t = fuelTargetsFor(
      {
        date: "2026-09-28",
        workouts: [workout({ type: "rest", durationMin: undefined })],
        ...ATHLETE,
      },
      { ...CFG, daily_deficit_kcal: 2000 },
    );
    expect(t.kcal).toBe(CFG.min_kcal);
  });

  it("scales with body weight", () => {
    const light = fuelTargetsFor(
      { date: "2026-09-28", workouts: [workout({})], ...ATHLETE, weightKg: 70 },
      CFG,
    );
    const heavy = fuelTargetsFor(
      { date: "2026-09-28", workouts: [workout({})], ...ATHLETE, weightKg: 85 },
      CFG,
    );
    expect(heavy.kcal).toBeGreaterThan(light.kcal);
    expect(heavy.proteinG).toBeGreaterThan(light.proteinG);
  });
});

describe("ageOn", () => {
  it("counts the birthday as passed on and after the day", () => {
    expect(ageOn("1990-06-15", "2026-06-15")).toBe(36);
    expect(ageOn("1990-06-15", "2026-09-07")).toBe(36);
  });

  it("does not count a birthday still ahead this year", () => {
    expect(ageOn("1990-06-15", "2026-06-14")).toBe(35);
    expect(ageOn("1990-12-31", "2026-01-01")).toBe(35);
  });
});

describe("latestWeightKg", () => {
  it("takes the most recent weigh-in, not the most recent day", () => {
    expect(
      latestWeightKg([
        { date: "2026-08-27", weight: 75.6 },
        { date: "2026-08-28", weight: 75.3 },
        { date: "2026-09-01" },
      ]),
    ).toBe(75.3);
  });

  it("returns null when nothing was ever logged", () => {
    expect(latestWeightKg([{ date: "2026-09-01" }])).toBeNull();
  });

  it("ignores a zero or negative reading", () => {
    expect(latestWeightKg([{ date: "2026-09-01", weight: 0 }])).toBeNull();
  });
});

describe("isWithinBlock", () => {
  const bounded = { ...CFG, start_date: "2026-09-28", end_date: "2026-12-06" };
  it("includes both endpoints and excludes outside", () => {
    expect(isWithinBlock("2026-09-28", bounded)).toBe(true);
    expect(isWithinBlock("2026-12-06", bounded)).toBe(true);
    expect(isWithinBlock("2026-09-27", bounded)).toBe(false);
    expect(isWithinBlock("2026-12-07", bounded)).toBe(false);
  });

  it("is unbounded when no dates are set", () => {
    expect(isWithinBlock("2020-01-01", CFG)).toBe(true);
  });
});

describe("fuelNoteEvents", () => {
  const week: PlannedWorkout[] = [
    workout({ date: "2026-09-28", type: "rest", durationMin: undefined }),
    workout({ date: "2026-09-29", type: "sweet_spot", intensityFactor: 0.88, durationMin: 60 }),
    workout({ date: "2026-09-29", type: "weights", durationMin: 60, intensityFactor: undefined }),
    workout({ date: "2026-10-03", durationMin: 180 }),
  ];

  it("emits one NOTE per planned day, including rest days", () => {
    const notes = fuelNoteEvents(week, ATHLETE, CFG);
    expect(notes.map((n) => n.start_date_local)).toEqual([
      "2026-09-28T00:00:00",
      "2026-09-29T00:00:00",
      "2026-10-03T00:00:00",
    ]);
    expect(notes.every((n) => n.category === "NOTE" && n.type === "Note")).toBe(true);
  });

  it("returns nothing when the block is disabled", () => {
    expect(fuelNoteEvents(week, ATHLETE, { ...CFG, enabled: false })).toEqual([]);
  });

  it("skips days outside the block window so a finished cut stops on its own", () => {
    const notes = fuelNoteEvents(week, ATHLETE, {
      ...CFG,
      start_date: "2026-09-29",
      end_date: "2026-09-30",
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].start_date_local).toBe("2026-09-29T00:00:00");
  });

  it("skips travel days, which the plan already treats as maintenance", () => {
    const notes = fuelNoteEvents(
      [workout({ date: "2026-10-05", type: "travel", durationMin: undefined })],
      ATHLETE,
      CFG,
    );
    expect(notes).toEqual([]);
  });

  it("writes a description with no workout-step lines, so Intervals.icu parses no steps", () => {
    const notes = fuelNoteEvents(week, ATHLETE, CFG);
    for (const n of notes) {
      const stepLines = (n.description ?? "").split("\n").filter((line) => /^\s*-\s/.test(line));
      expect(stepLines).toEqual([]);
    }
  });
});

describe("fuel note rendering", () => {
  const targets = fuelTargetsFor(
    { date: "2026-10-03", workouts: [workout({ durationMin: 180 })], ...ATHLETE },
    CFG,
  );

  it("names the note with the day's headline numbers", () => {
    expect(fuelNoteName(targets)).toBe("Fuel 3,625 kcal · 165g protein");
  });

  it("states the on-bike rate and its session total", () => {
    const text = fuelNoteDescription(targets);
    expect(text).toContain("60-90g carb/h");
    expect(text).toContain("180-270g total");
  });

  it("says on-bike fuel is inside the day's budget, not on top of it", () => {
    expect(fuelNoteDescription(targets)).toContain("not on top of it");
  });

  it("tells a short easy day to ride low-carb instead", () => {
    const easy = fuelTargetsFor(
      { date: "2026-09-30", workouts: [workout({ durationMin: 75 })], ...ATHLETE },
      CFG,
    );
    expect(fuelNoteDescription(easy)).toContain("no carbs needed");
  });
});
