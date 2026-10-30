import { describe, it, expect, vi } from "vitest";
import { IntervalsClient } from "../src/intervals.js";
import { endOfWeekCtl, formatWeeklyReview, summarizeWeeks, weekKey } from "../src/weeklyReview.js";
import type { Activity, WellnessEntry } from "../src/types.js";

function activity(date: string, overrides: Partial<Activity> = {}): Activity {
  return {
    id: `i${date}`,
    start_date_local: `${date}T07:00:00`,
    start_date: `${date}T11:00:00Z`,
    type: "Ride",
    icu_training_load: 50,
    moving_time: 3600,
    icu_intensity: 0.7,
    icu_zone_times: [600, 1800, 600, 300, 300, 0, 0],
    icu_ss_time: null,
    ...overrides,
  };
}

const wellness = (date: string, ctl: number): WellnessEntry => ({ date, ctl, atl: ctl, tsb: 0 });

describe("weekKey", () => {
  it("anchors any day of the week to its Monday", () => {
    expect(weekKey("2026-10-26")).toBe("2026-10-26"); // Monday
    expect(weekKey("2026-11-01T23:30:00")).toBe("2026-10-26"); // late Sunday
  });

  it("crosses a month and a DST change", () => {
    expect(weekKey("2026-11-02")).toBe("2026-11-02");
    expect(weekKey("2026-03-08")).toBe("2026-03-02"); // US spring-forward Sunday
  });

  it("returns null for a missing date", () => {
    expect(weekKey("")).toBeNull();
  });
});

describe("summarizeWeeks", () => {
  it("aggregates volume, ride counts and the longest ride per week", () => {
    const weeks = summarizeWeeks([
      activity("2026-10-26"),
      activity("2026-10-28", { moving_time: 7200, icu_training_load: 90 }),
      activity("2026-10-29", { type: "WeightTraining", icu_training_load: 20, moving_time: 1800 }),
      activity("2026-11-02"),
    ]);

    expect([...weeks.keys()]).toEqual(["2026-10-26", "2026-11-02"]);
    expect(weeks.get("2026-10-26")).toMatchObject({
      tss: 160,
      hours: 3.5,
      rides: 2,
      weights: 1,
      longRide: 2,
      byType: { Ride: 140, WeightTraining: 20 },
    });
  });

  it("splits easy from hard zone time", () => {
    const week = summarizeWeeks([activity("2026-10-26")]).get("2026-10-26")!;
    expect(week.z12s).toBe(2400);
    expect(week.hards).toBe(1200);
  });

  it("does not count the overlapping sweet-spot bucket as hard time", async () => {
    // The API's object form includes {id:"SS"}, which overlaps Z3/Z4. Going
    // through the real client proves it can't inflate the hard total.
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: "i1",
              start_date_local: "2026-10-26T07:00:00",
              type: "Ride",
              icu_training_load: 50,
              moving_time: 3600,
              icu_zone_times: [
                { id: "Z1", secs: 600 },
                { id: "Z2", secs: 1800 },
                { id: "Z3", secs: 600 },
                { id: "Z4", secs: 600 },
                { id: "SS", secs: 900 },
              ],
            },
          ]),
        ),
    ) as unknown as typeof fetch;
    const client = new IntervalsClient("k", fetchFn);

    const week = summarizeWeeks(await client.getActivities("2026-10-26", "2026-10-26")).get(
      "2026-10-26",
    )!;

    expect(week.hours).toBe(1);
    expect(week.z12s).toBe(2400);
    expect(week.hards).toBe(1200);
  });

  it("treats an activity with no duration or zones as zero, not NaN", () => {
    const week = summarizeWeeks([
      activity("2026-10-26", { moving_time: undefined, icu_zone_times: null }),
    ]).get("2026-10-26")!;
    expect(week).toMatchObject({ hours: 0, z12s: 0, hards: 0 });
  });

  it("falls back to the UTC start, and skips an activity with no date", () => {
    const weeks = summarizeWeeks([
      activity("2026-10-26", { start_date_local: "" }),
      activity("2026-11-02", { start_date_local: "", start_date: "" }),
    ]);
    expect([...weeks.keys()]).toEqual(["2026-10-26"]);
  });
});

describe("endOfWeekCtl", () => {
  it("uses the last day of the week with data", () => {
    const range = [wellness("2026-10-27", 45), wellness("2026-10-29", 47)];
    expect(endOfWeekCtl(range, "2026-10-26")).toBe(47);
  });

  it("ignores a zeroed entry from before activities sync", () => {
    const range = [wellness("2026-10-29", 47), wellness("2026-10-30", 0)];
    expect(endOfWeekCtl(range, "2026-10-26")).toBe(47);
  });

  it("does not read past the end of the week", () => {
    expect(endOfWeekCtl([wellness("2026-11-02", 50)], "2026-10-26")).toBe(0);
  });
});

describe("formatWeeklyReview", () => {
  it("prints a row per week with easy % and the CTL ramp", () => {
    const out = formatWeeklyReview(
      summarizeWeeks([activity("2026-10-26"), activity("2026-11-02")]),
      [wellness("2026-11-01", 45), wellness("2026-11-05", 47)],
      2,
    );
    expect(out).toContain("last 2 weeks (2026-10-26 → 2026-11-02)");
    expect(out).toMatch(/2026-10-26\s+50\s+1\.0\s+1\s+0\s+67%\s+1\.0\s+45\.0\s+\+0\.0/);
    expect(out).toMatch(/2026-11-02\s+50\s+1\.0\s+1\s+0\s+67%\s+1\.0\s+47\.0\s+\+2\.0/);
  });

  it("says so when there is nothing to report", () => {
    expect(formatWeeklyReview(new Map(), [], 8)).toContain("No activities in the last 8 weeks.");
  });
});
