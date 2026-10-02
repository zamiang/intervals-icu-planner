import { describe, it, expect } from "vitest";
import {
  easyEnduranceWorkout,
  sweetSpotWorkout,
  hardIntervalWorkout,
  structuredWorkoutFor,
  INTERVAL_LADDERS,
} from "../src/workout.js";
import type { PlannedWorkout } from "../src/types.js";

describe("easyEnduranceWorkout", () => {
  it("writes the power band ahead of the HR zone, in the order the parser expects", () => {
    const w = easyEnduranceWorkout(75, 62);
    // An HR-only step leaves normalized_power at 0 (broken planned load); the
    // power target fixes it, and `% Z2 HR` is the order Intervals.icu parses.
    // The target is a ±6% band centered on the planned IF: an exact percent is
    // unrideable outdoors and gets ignored, which showed up as easy rides
    // consistently ridden ~10% over target.
    expect(w.text).toContain("56-68% Z2 HR");
    expect(w.text.trim().startsWith("- 75m")).toBe(true);
    expect(w.minutes).toBe(75);
  });

  it("reports an intensityFactor matching the band midpoint", () => {
    // Intervals.icu derives planned load from the band midpoint (the whole
    // percent the band is built around); intensityFactor must mirror it so a
    // caller's submitted TSS matches the step Intervals.icu reads.
    expect(easyEnduranceWorkout(180, 62).intensityFactor).toBe(0.62);
    expect(easyEnduranceWorkout(75, 63).intensityFactor).toBe(0.63);
    expect(easyEnduranceWorkout(75, 63).text).toContain("57-69% Z2 HR");
  });
});

describe("sweetSpotWorkout", () => {
  const w = sweetSpotWorkout();

  it("uses power targets so Intervals.icu derives watts from stored FTP", () => {
    expect(w.text).toContain("88-94%");
    expect(w.text).not.toContain("HR"); // power-targeted, not HR
  });

  it("has a warmup, a repeated main set, and a cooldown", () => {
    expect(w.text).toContain("Warmup");
    expect(w.text).toContain("Main Set 3x");
    expect(w.text).toContain("12m 88-94%");
    expect(w.text).toContain("Cooldown");
  });

  it("reports a total duration consistent with its steps", () => {
    // 10 warmup + 3x(0.5+0.5) openers + 3x(12+5) main + 8 cooldown = 72
    expect(w.minutes).toBe(72);
  });
});

describe("hardIntervalWorkout", () => {
  it("builds a VO2 Max session with power targets off stored FTP", () => {
    const w = hardIntervalWorkout("vo2");
    expect(w.text).toContain("Main Set 5x");
    expect(w.text).toContain("3m 110-118% VO2 Max");
    expect(w.text).not.toContain("HR"); // power-targeted, not HR
    // 12 warmup + 2x(0.5+0.5) openers + 5x(3+3) main + 8 cooldown = 52
    expect(w.minutes).toBe(52);
  });

  it("builds a threshold session at 95-102% FTP", () => {
    const w = hardIntervalWorkout("threshold");
    expect(w.text).toContain("Main Set 4x");
    expect(w.text).toContain("8m 95-102% Threshold");
    expect(w.minutes).toBe(70); // 12 + 2 + 4x(8+4) + 8
  });

  it("builds an anaerobic session of short, very-high-power efforts", () => {
    const w = hardIntervalWorkout("anaerobic");
    expect(w.text).toContain("Main Set 8x");
    expect(w.text).toContain("1m 125-140% Anaerobic");
    expect(w.minutes).toBe(46); // 12 + 2 + 8x(1+2) + 8
  });

  it("estimates each session's IF as normalized power over its steps", () => {
    // NP weights hard efforts by the 4th power, so a short VO2 session reads
    // harder than a longer sweet-spot one despite a lower average power.
    expect(sweetSpotWorkout().intensityFactor).toBe(0.8);
    expect(hardIntervalWorkout("vo2").intensityFactor).toBe(0.87);
    expect(hardIntervalWorkout("threshold").intensityFactor).toBe(0.84);
    for (const z of ["threshold", "vo2", "anaerobic"] as const) {
      const ifv = hardIntervalWorkout(z).intensityFactor;
      expect(ifv).toBeGreaterThan(0.75);
      expect(ifv).toBeLessThan(1);
    }
  });

  it("climbs each ladder, adding work time at every rung and holding at the top", () => {
    const work = (text: string): number => {
      const m = /Main Set (\d+)x\n- (\d+)m/.exec(text)!;
      return Number(m[1]) * Number(m[2]);
    };
    for (const z of ["threshold", "vo2", "anaerobic"] as const) {
      const ladder = INTERVAL_LADDERS[z];
      for (let i = 1; i < ladder.length; i++) {
        expect(work(hardIntervalWorkout(z, i).text)).toBeGreaterThanOrEqual(
          work(hardIntervalWorkout(z, i - 1).text),
        );
      }
      expect(hardIntervalWorkout(z, 99).text).toBe(hardIntervalWorkout(z, ladder.length - 1).text);
    }
    expect(hardIntervalWorkout("vo2", 4).text).toContain("Main Set 5x\n- 5m 105-112% VO2 Max");
    expect(sweetSpotWorkout(2).text).toContain("Main Set 2x\n- 20m 88-94% Sweet spot");
    expect(sweetSpotWorkout(3).text).toContain("20m 90-95%");
    expect(sweetSpotWorkout(-1).text).toBe(sweetSpotWorkout(0).text);
  });

  it("builds the stamped progression step from a planned workout", () => {
    const s = structuredWorkoutFor(
      planned({ intensity: "hard", targetZone: "vo2", progressionStep: 2 }),
    );
    expect(s?.text).toContain("Main Set 5x\n- 4m 106-115% VO2 Max");
  });

  it("falls back to the sweet-spot session for the sweet_spot zone", () => {
    expect(hardIntervalWorkout("sweet_spot").text).toBe(sweetSpotWorkout().text);
  });
});

const planned = (over: Partial<PlannedWorkout>): PlannedWorkout => ({
  date: "2026-06-22",
  type: "cycling",
  name: "Ride",
  description: "prose",
  intensity: "easy",
  ...over,
});

describe("structuredWorkoutFor", () => {
  it("builds a power workout for the sweet-spot session", () => {
    const s = structuredWorkoutFor(planned({ type: "sweet_spot", intensity: "hard" }));
    expect(s?.text).toContain("88-94%");
  });

  it("builds a power+HR endurance workout for an easy ride with duration and IF", () => {
    const s = structuredWorkoutFor(
      planned({ intensity: "easy", durationMin: 90, intensityFactor: 0.62 }),
    );
    expect(s?.text).toContain("56-68% Z2 HR"); // power band (load from midpoint) + HR-zone target (display)
    expect(s?.minutes).toBe(90);
  });

  it("returns null for easy rides with no planned duration", () => {
    expect(structuredWorkoutFor(planned({ intensity: "easy", intensityFactor: 0.62 }))).toBeNull();
  });

  it("returns null for easy rides with no planned IF (no power target to compute load)", () => {
    expect(structuredWorkoutFor(planned({ intensity: "easy", durationMin: 90 }))).toBeNull();
  });

  it("builds the target zone's interval session for a hard cycling ride", () => {
    const s = structuredWorkoutFor(planned({ intensity: "hard", targetZone: "vo2" }));
    expect(s?.text).toContain("Main Set 5x");
    expect(s?.text).toContain("110-118% VO2 Max");
  });

  it("returns null for a hard ride with no target zone (no zone to build from)", () => {
    expect(structuredWorkoutFor(planned({ intensity: "hard", durationMin: 75 }))).toBeNull();
  });

  it("returns null for moderate-intensity rides (only easy rides get an HR workout)", () => {
    expect(structuredWorkoutFor(planned({ intensity: "moderate", durationMin: 75 }))).toBeNull();
  });

  it("returns null for weights and rest", () => {
    expect(structuredWorkoutFor(planned({ type: "weights", intensity: "hard" }))).toBeNull();
    expect(structuredWorkoutFor(planned({ type: "rest" }))).toBeNull();
  });
});
