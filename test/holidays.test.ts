import { describe, it, expect } from "vitest";
import {
  applyHolidayPolicy,
  holidayDatesInWindow,
  holidayPlaceholderEvent,
  holidayPlaceholderWorkout,
  HOLIDAY_PLACEHOLDER,
} from "../src/holidays.js";
import type { IntervalsEvent } from "../src/types.js";

const holiday = (start: string, end?: string, name = "In London"): IntervalsEvent => ({
  start_date_local: `${start}T00:00:00`,
  ...(end ? { end_date_local: `${end}T00:00:00` } : {}),
  name,
  category: "HOLIDAY",
});

const workout = (date: string, name: string): IntervalsEvent => ({
  start_date_local: `${date}T00:00:00`,
  name,
  category: "WORKOUT",
});

describe("holidayDatesInWindow", () => {
  it("expands a multi-day holiday, treating the T00:00:00 end as exclusive", () => {
    // Mirrors the live API: a holiday shown Aug 2-14 reads back with
    // end_date_local 2026-08-15T00:00:00.
    const dates = holidayDatesInWindow(
      [holiday("2026-08-02", "2026-08-15")],
      "2026-08-01",
      "2026-08-31",
    );
    expect(dates.has("2026-08-01")).toBe(false);
    expect(dates.has("2026-08-02")).toBe(true);
    expect(dates.has("2026-08-14")).toBe(true);
    expect(dates.has("2026-08-15")).toBe(false);
    expect(dates.size).toBe(13);
  });

  it("intersects the holiday span with the planning window", () => {
    // Week fully inside the trip: every day is covered.
    const inside = holidayDatesInWindow(
      [holiday("2026-08-02", "2026-08-15")],
      "2026-08-03",
      "2026-08-09",
    );
    expect(inside.size).toBe(7);

    // Week straddling the start: only the tail is covered.
    const straddle = holidayDatesInWindow(
      [holiday("2026-08-02", "2026-08-15")],
      "2026-07-27",
      "2026-08-02",
    );
    expect([...straddle]).toEqual(["2026-08-02"]);
  });

  it("covers only the start day when there is no end date", () => {
    const dates = holidayDatesInWindow([holiday("2026-08-02")], "2026-08-01", "2026-08-31");
    expect([...dates]).toEqual(["2026-08-02"]);
  });

  it("treats an end equal to the start as a single-day holiday", () => {
    const dates = holidayDatesInWindow(
      [holiday("2026-08-02", "2026-08-02")],
      "2026-08-01",
      "2026-08-31",
    );
    expect([...dates]).toEqual(["2026-08-02"]);
  });

  it("includes the end day itself when the end has a non-midnight time", () => {
    const e: IntervalsEvent = {
      start_date_local: "2026-08-02T00:00:00",
      end_date_local: "2026-08-04T14:00:00",
      name: "Trip",
      category: "HOLIDAY",
    };
    const dates = holidayDatesInWindow([e], "2026-08-01", "2026-08-31");
    expect([...dates].sort()).toEqual(["2026-08-02", "2026-08-03", "2026-08-04"]);
  });

  it("still treats a drifted midnight-end format as exclusive", () => {
    // If the API ever adds milliseconds or a zone suffix, the end must stay
    // exclusive — otherwise every holiday silently grows by one day.
    for (const end of [
      "2026-08-05",
      "2026-08-05T00:00",
      "2026-08-05T00:00:00.000",
      "2026-08-05T00:00:00Z",
      "2026-08-05T00:00:00+01:00",
    ]) {
      const e: IntervalsEvent = {
        start_date_local: "2026-08-02T00:00:00",
        end_date_local: end,
        name: "Trip",
        category: "HOLIDAY",
      };
      const dates = holidayDatesInWindow([e], "2026-08-01", "2026-08-31");
      expect([...dates].sort(), `end ${end}`).toEqual(["2026-08-02", "2026-08-03", "2026-08-04"]);
    }
  });

  it("ignores non-HOLIDAY events even when they span dates", () => {
    const e: IntervalsEvent = {
      start_date_local: "2026-08-02T00:00:00",
      end_date_local: "2026-08-05T00:00:00",
      name: "Training camp",
      category: "WORKOUT",
    };
    expect(holidayDatesInWindow([e], "2026-08-01", "2026-08-31").size).toBe(0);
  });

  it("merges overlapping holidays into one set of covered days", () => {
    const dates = holidayDatesInWindow(
      [holiday("2026-08-02", "2026-08-05"), holiday("2026-08-04", "2026-08-08", "Side trip")],
      "2026-08-01",
      "2026-08-31",
    );
    expect([...dates].sort()).toEqual([
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);
  });
});

describe("applyHolidayPolicy", () => {
  const holidaySet = new Set(["2026-08-03", "2026-08-04"]);

  it("passes non-holiday days through untouched", () => {
    const events = [workout("2026-08-01", "Easy Ride"), workout("2026-08-02", "Strength")];
    const result = applyHolidayPolicy(events, holidaySet, "skip");
    expect(result.events).toEqual(events);
    expect(result.dropped).toEqual([]);
  });

  it("drops holiday-day events in skip mode", () => {
    const keep = workout("2026-08-01", "Easy Ride");
    const drop = workout("2026-08-03", "Sweet Spot");
    const result = applyHolidayPolicy([keep, drop], holidaySet, "skip");
    expect(result.events).toEqual([keep]);
    expect(result.dropped).toEqual([drop]);
  });

  it("coalesces holiday-day events into one placeholder per day in placeholder mode", () => {
    // Two sessions stacked on the same holiday day become a single placeholder.
    const events = [
      workout("2026-08-03", "Hard Ride"),
      workout("2026-08-03", "Strength"),
      workout("2026-08-04", "Easy Ride"),
    ];
    const result = applyHolidayPolicy(events, holidaySet, "placeholder");
    expect(result.dropped).toHaveLength(3);
    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => e.name === HOLIDAY_PLACEHOLDER.name)).toBe(true);
    expect(result.events.map((e) => e.start_date_local.slice(0, 10))).toEqual([
      "2026-08-03",
      "2026-08-04",
    ]);
    expect([...result.placeholderDates].sort()).toEqual(["2026-08-03", "2026-08-04"]);
  });

  it("emits no placeholder for a holiday day that already holds a real event", () => {
    // Same rule as the scheduler's Phase H — and the guard that keeps
    // push-week --replace from consuming the day's existing event as an
    // update target and overwriting it with travel content.
    const events = [workout("2026-08-03", "Hard Ride"), workout("2026-08-04", "Easy Ride")];
    const occupied = new Set(["2026-08-03"]);
    const result = applyHolidayPolicy(events, holidaySet, "placeholder", occupied);
    expect(result.dropped).toHaveLength(2);
    expect(result.events.map((e) => e.start_date_local.slice(0, 10))).toEqual(["2026-08-04"]);
    expect([...result.placeholderDates]).toEqual(["2026-08-04"]);
  });
});

describe("placeholder builders", () => {
  it("builds a zero-load event with an explicit moving_time", () => {
    const e = holidayPlaceholderEvent("2026-08-03");
    expect(e.category).toBe("WORKOUT");
    expect(e.type).toBe("Workout");
    // Explicit duration so Intervals.icu never derives a bogus one by parsing
    // the prose; no TSS/IF so the day contributes nothing to planned CTL.
    expect(e.moving_time).toBe(HOLIDAY_PLACEHOLDER.duration_minutes * 60);
    expect(e.icu_training_load).toBeUndefined();
    expect(e.icu_intensity).toBeUndefined();
  });

  it("builds a travel workout carrying the same content", () => {
    const w = holidayPlaceholderWorkout("2026-08-03");
    expect(w.type).toBe("travel");
    expect(w.name).toBe(HOLIDAY_PLACEHOLDER.name);
    expect(w.load).toBeUndefined();
    expect(w.durationMin).toBe(HOLIDAY_PLACEHOLDER.duration_minutes);
  });
});
