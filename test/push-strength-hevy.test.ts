import { describe, it, expect } from "vitest";
import { toLocalDateTime, manualActivityFor } from "../scripts/push-strength-hevy.js";
import { MARKER } from "../src/strength.js";

describe("toLocalDateTime", () => {
  it("renders a local wall-clock time that round-trips to the same UTC instant", () => {
    // The invariant the Hevy matcher depends on: Intervals.icu interprets
    // start_date_local in the athlete's timezone, so parsing the rendered
    // string as local time must land on the original UTC instant. This holds
    // in any host timezone, so the test is TZ-independent.
    const iso = "2026-07-06T19:51:44+00:00";
    expect(Date.parse(toLocalDateTime(iso))).toBe(Date.parse(iso));
  });

  it("formats as YYYY-MM-DDTHH:mm:ss with zero-padding and no zone suffix", () => {
    expect(toLocalDateTime("2026-01-02T03:04:05Z")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    );
  });
});

describe("manualActivityFor", () => {
  const description = `${MARKER}\nZercher Squat: 4×6@90lb`;

  it("builds a WeightTraining payload with duration and a Hevy-linked external_id", () => {
    const activity = manualActivityFor(
      {
        id: "bfb6f583-254b-4011-b091-13b7b22cd849",
        start_time: "2026-06-28T12:57:20+00:00",
        end_time: "2026-06-28T13:49:59+00:00",
      },
      description,
    );

    expect(activity).toMatchObject({
      type: "WeightTraining",
      name: "Strength Training",
      moving_time: 3159, // 52m39s from the Hevy start/end times
      description,
      external_id: "hevy-bfb6f583-254b-4011-b091-13b7b22cd849",
    });
    expect(activity.start_date_local).toBe(toLocalDateTime("2026-06-28T12:57:20+00:00"));
  });

  it("omits moving_time when end_time is missing", () => {
    const activity = manualActivityFor(
      { id: "w1", start_time: "2026-06-28T12:57:20+00:00" },
      description,
    );
    expect(activity).not.toHaveProperty("moving_time");
  });

  it("omits moving_time when end_time is malformed or before start_time", () => {
    const malformed = manualActivityFor(
      { id: "w1", start_time: "2026-06-28T12:57:20+00:00", end_time: "not-a-date" },
      description,
    );
    expect(malformed).not.toHaveProperty("moving_time");

    const backwards = manualActivityFor(
      {
        id: "w1",
        start_time: "2026-06-28T12:57:20+00:00",
        end_time: "2026-06-28T12:00:00+00:00",
      },
      description,
    );
    expect(backwards).not.toHaveProperty("moving_time");
  });
});
