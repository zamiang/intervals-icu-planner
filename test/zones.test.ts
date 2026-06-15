import { describe, it, expect } from "vitest";
import {
  classifyActivity,
  computeDistribution,
  emptyDistribution,
  mostDeficientZone,
  POLARIZED_TARGETS,
  zoneLabel,
} from "../src/zones.js";
import type { Activity } from "../src/types.js";

function ride(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "i1",
    start_date_local: "2026-04-01T08:00:00",
    start_date: "2026-04-01T12:00:00Z",
    type: "Ride",
    icu_training_load: 50,
    icu_intensity: 0.7,
    icu_zone_times: null,
    icu_ss_time: null,
    ...overrides,
  };
}

describe("classifyActivity", () => {
  it("returns null for non-ride activities", () => {
    expect(classifyActivity(ride({ type: "Run" }))).toBeNull();
    expect(classifyActivity(ride({ type: "Swim" }))).toBeNull();
  });

  it("returns null for rides with no TSS", () => {
    expect(classifyActivity(ride({ icu_training_load: 0 }))).toBeNull();
  });

  it("uses dominant zone_times bucket when available", () => {
    // Z4 (index 3) dominant → threshold
    expect(
      classifyActivity(
        ride({ icu_zone_times: [100, 200, 300, 1500, 100, 0, 0], icu_intensity: 0.5 }),
      ),
    ).toBe("threshold");
    // Z2 (index 1) dominant → endurance
    expect(
      classifyActivity(
        ride({ icu_zone_times: [200, 3000, 100, 50, 0, 0, 0], icu_intensity: 0.95 }),
      ),
    ).toBe("endurance");
    // Z5 (index 4) dominant → vo2
    expect(classifyActivity(ride({ icu_zone_times: [0, 200, 400, 600, 1200, 100, 0] }))).toBe(
      "vo2",
    );
  });

  it("ignores the SS bucket when an ordinary zone dominates", () => {
    // Z2-dominant endurance ride that still logged some sweet-spot seconds.
    expect(
      classifyActivity(
        ride({
          icu_zone_times: [758, 5400, 600, 400, 120, 60, 53],
          icu_ss_time: 1260,
          icu_intensity: 0.65,
        }),
      ),
    ).toBe("endurance");
  });

  it("prefers the SS bucket when it outweighs every individual zone", () => {
    // Sweet-spot session: time straddles Z3/Z4 so neither bucket dominates,
    // but the overlapping SS bucket holds more than either.
    expect(
      classifyActivity(
        ride({
          icu_zone_times: [300, 600, 900, 800, 100, 0, 0],
          icu_ss_time: 1500,
          icu_intensity: 0.89,
        }),
      ),
    ).toBe("sweet_spot");
  });

  it("falls back to IF banding when zone_times is absent", () => {
    expect(classifyActivity(ride({ icu_intensity: 0.7 }))).toBe("endurance");
    expect(classifyActivity(ride({ icu_intensity: 0.8 }))).toBe("tempo");
    expect(classifyActivity(ride({ icu_intensity: 0.9 }))).toBe("sweet_spot");
    // 89.3% from the API arrives here as 0.893 after client normalization
    expect(classifyActivity(ride({ icu_intensity: 0.893 }))).toBe("sweet_spot");
    expect(classifyActivity(ride({ icu_intensity: 1.0 }))).toBe("threshold");
    expect(classifyActivity(ride({ icu_intensity: 1.1 }))).toBe("vo2");
    expect(classifyActivity(ride({ icu_intensity: 1.3 }))).toBe("anaerobic");
  });

  it("falls back to IF when zone_times exists but is all zero", () => {
    expect(
      classifyActivity(ride({ icu_zone_times: [0, 0, 0, 0, 0, 0, 0], icu_intensity: 0.9 })),
    ).toBe("sweet_spot");
  });

  it("returns null when neither zone_times nor IF is usable", () => {
    expect(classifyActivity(ride({ icu_intensity: null, icu_zone_times: null }))).toBeNull();
  });

  it("matches VirtualRide type", () => {
    expect(classifyActivity(ride({ type: "VirtualRide", icu_intensity: 0.7 }))).toBe("endurance");
  });
});

describe("computeDistribution", () => {
  it("returns an empty distribution when no activities classify", () => {
    const dist = computeDistribution([ride({ type: "Run" })]);
    expect(dist).toEqual(emptyDistribution());
  });

  it("returns TSS-weighted fractions summing to 1", () => {
    const dist = computeDistribution([
      ride({ icu_intensity: 0.7, icu_training_load: 80 }), // endurance
      ride({ icu_intensity: 0.7, icu_training_load: 70 }), // endurance
      ride({ icu_intensity: 1.0, icu_training_load: 50 }), // threshold
    ]);
    expect(dist.endurance).toBeCloseTo(150 / 200, 5);
    expect(dist.threshold).toBeCloseTo(50 / 200, 5);
    const sum = Object.values(dist).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("ignores activities that don't classify (runs, no-power)", () => {
    const dist = computeDistribution([
      ride({ icu_intensity: 0.7, icu_training_load: 50 }),
      ride({ type: "Run", icu_training_load: 200 }),
      ride({ icu_intensity: null, icu_zone_times: null, icu_training_load: 100 }),
    ]);
    expect(dist.endurance).toBeCloseTo(1.0, 5);
  });
});

describe("mostDeficientZone", () => {
  it("picks the hard zone with the largest target-minus-actual gap", () => {
    const actual = { ...emptyDistribution(), endurance: 0.7, threshold: 0.05, vo2: 0.05 };
    const z = mostDeficientZone(actual);
    // sweet_spot (target 0.10, actual 0) has biggest deficit; threshold and vo2
    // each have 0.05/0.10 deficits, sweet_spot wins.
    expect(z).toBe("sweet_spot");
  });

  it("excludes already-used zones", () => {
    const actual = emptyDistribution();
    const used = new Set(["sweet_spot" as const]);
    const z = mostDeficientZone(actual, POLARIZED_TARGETS, used);
    // With sweet_spot excluded, vo2 has the next-largest deficit (0.15 target)
    expect(z).toBe("vo2");
  });

  it("never returns endurance or tempo (those aren't hard-ride targets)", () => {
    // Even if the actual distribution heavily over-represents endurance and
    // tempo is the largest deficit, the function picks among hard zones only.
    const actual = { ...emptyDistribution(), threshold: 0.5, sweet_spot: 0.5 };
    const z = mostDeficientZone(actual);
    expect(["vo2", "anaerobic"]).toContain(z);
  });
});

describe("zoneLabel", () => {
  it("formats each zone with a human label", () => {
    expect(zoneLabel("sweet_spot")).toBe("Sweet Spot");
    expect(zoneLabel("vo2")).toBe("VO2 Max");
  });
});
