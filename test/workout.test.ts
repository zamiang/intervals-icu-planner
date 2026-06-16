import { describe, it, expect } from "vitest";
import { easyEnduranceWorkout, sweetSpotWorkout, structuredWorkoutFor } from "../src/workout.js";
import type { PlannedWorkout } from "../src/types.js";

describe("easyEnduranceWorkout", () => {
  it("writes the power target ahead of the HR zone, in the order the parser expects", () => {
    const w = easyEnduranceWorkout(75, 62);
    // An HR-only step leaves normalized_power at 0 (broken planned load); the
    // power target fixes it, and `% Z2 HR` is the order Intervals.icu parses.
    expect(w.text).toContain("62% Z2 HR");
    expect(w.text.trim().startsWith("- 75m")).toBe(true);
    expect(w.minutes).toBe(75);
  });

  it("reports an intensityFactor matching the whole-percent power target", () => {
    // The step text rounds to a whole percent; intensityFactor must mirror that
    // rounding so a caller's submitted TSS matches the step Intervals.icu reads.
    expect(easyEnduranceWorkout(180, 62).intensityFactor).toBe(0.62);
    expect(easyEnduranceWorkout(75, 63).intensityFactor).toBe(0.63);
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
    expect(s?.text).toContain("62% Z2 HR"); // power target (load) + HR-zone target (display)
    expect(s?.minutes).toBe(90);
  });

  it("returns null for easy rides with no planned duration", () => {
    expect(structuredWorkoutFor(planned({ intensity: "easy", intensityFactor: 0.62 }))).toBeNull();
  });

  it("returns null for easy rides with no planned IF (no power target to compute load)", () => {
    expect(structuredWorkoutFor(planned({ intensity: "easy", durationMin: 90 }))).toBeNull();
  });

  it("returns null for hard Xert rides (no deterministic structure)", () => {
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
