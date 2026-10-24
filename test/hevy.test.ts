import { describe, it, expect, vi, afterEach } from "vitest";
import {
  toLocalDateTime,
  manualActivityFor,
  parseHevyPage,
  fetchHevyPage,
  fetchHevyWorkouts,
  matchActivity,
  toExercises,
  syncHevyWorkouts,
  type HevyClient,
  type HevySyncOptions,
  type HevyWorkout,
} from "../src/hevy.js";
import type { Activity } from "../src/types.js";
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

describe("parseHevyPage", () => {
  it("extracts page_count and workouts from the documented response shape", () => {
    const page = parseHevyPage({ page: 1, page_count: 3, workouts: [{ id: "w1" }] });
    expect(page.pageCount).toBe(3);
    expect(page.workouts).toEqual([{ id: "w1" }]);
  });

  it("tolerates a bare array with an unknown page count", () => {
    const page = parseHevyPage([{ id: "w1" }]);
    expect(page.pageCount).toBe(Infinity);
    expect(page.workouts).toEqual([{ id: "w1" }]);
  });
});

describe("fetchHevyPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats a 404 as the end of pagination instead of throwing", async () => {
    // Hevy 404s any page past page_count, so a workout count that is an exact
    // multiple of the page size must not crash the run (the 2026-07-20 failure).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Page not found" }), { status: 404 })),
    );
    await expect(fetchHevyPage(2, "key")).resolves.toEqual({ pageCount: 1, workouts: [] });
  });

  it("still throws on other error statuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(fetchHevyPage(1, "key")).rejects.toThrow("Hevy API error (401)");
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

function workout(id: string, start: string, overrides: Partial<HevyWorkout> = {}): HevyWorkout {
  return {
    id,
    title: "Routine A",
    start_time: start,
    end_time: new Date(Date.parse(start) + 45 * 60_000).toISOString(),
    exercises: [
      {
        title: "Goblet Squat",
        sets: [
          { type: "warmup", weight_kg: 10, reps: 10, duration_seconds: null, rpe: null },
          { type: "normal", weight_kg: 20, reps: 8, duration_seconds: null, rpe: 8 },
          { type: "normal", weight_kg: 20, reps: 8, duration_seconds: null, rpe: 8 },
        ],
      },
    ],
    ...overrides,
  };
}

function strengthActivity(id: string, startUtc: string, type = "WeightTraining"): Activity {
  return {
    id,
    start_date_local: startUtc.replace("Z", ""),
    start_date: startUtc,
    type,
    icu_training_load: 0,
    icu_intensity: null,
    icu_zone_times: null,
    icu_ss_time: null,
  };
}

describe("matchActivity", () => {
  const acts = [
    strengthActivity("far", "2026-07-06T19:40:00Z"),
    strengthActivity("near", "2026-07-06T19:53:00Z"),
  ];

  it("picks the closest activity inside the tolerance", () => {
    expect(matchActivity(acts, "2026-07-06T19:51:44Z", 15 * 60_000)).toBe("near");
  });

  it("returns null when nothing is within the tolerance", () => {
    expect(matchActivity(acts, "2026-07-06T21:00:00Z", 10 * 60_000)).toBeNull();
  });
});

describe("toExercises", () => {
  it("drops warmup sets unless asked, and converts kg to lb", () => {
    const [squat] = toExercises(workout("w", "2026-07-06T19:51:44Z"), false);
    expect(squat.sets).toHaveLength(2);
    expect(squat.sets[0].weightLb).toBeCloseTo(44.09, 1);
    expect(squat.sets[0].rpe).toBe("8");

    expect(toExercises(workout("w", "2026-07-06T19:51:44Z"), true)[0].sets).toHaveLength(3);
  });
});

describe("fetchHevyWorkouts", () => {
  const page = (n: number, count: number, pageCount: number) =>
    new Response(
      JSON.stringify({
        page: n,
        page_count: pageCount,
        workouts: Array.from({ length: count }, (_, i) => ({ id: `p${n}-${i}` })),
      }),
    );

  it("stops at the last page even when more were requested", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      page(Number(new URL(String(url)).searchParams.get("page")), 10, 2),
    ) as unknown as typeof fetch;
    const workouts = await fetchHevyWorkouts("key", 5, fetchFn);
    expect(workouts).toHaveLength(20);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("stops on a short page", async () => {
    const fetchFn = vi.fn(async () => page(1, 3, 9)) as unknown as typeof fetch;
    expect(await fetchHevyWorkouts("key", 5, fetchFn)).toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("syncHevyWorkouts", () => {
  const START = "2026-07-06T19:51:44Z";

  function fakeClient(activities: Activity[], descriptions: Record<string, string> = {}) {
    return {
      getActivities: vi.fn<HevyClient["getActivities"]>(async () => activities),
      getActivityDescription: vi.fn<HevyClient["getActivityDescription"]>(
        async (id) => descriptions[id] ?? "",
      ),
      updateActivity: vi.fn<HevyClient["updateActivity"]>(async () => {}),
      createManualActivity: vi.fn<HevyClient["createManualActivity"]>(async () => ({ id: "new" })),
    };
  }

  const opts = (overrides: Partial<HevySyncOptions> = {}): HevySyncOptions => ({
    apply: true,
    force: false,
    includeWarmups: false,
    createMissing: false,
    toleranceMin: 10,
    log: () => {},
    ...overrides,
  });

  it("writes the lift detail into the matching WeightTraining activity", async () => {
    const client = fakeClient([strengthActivity("i1", "2026-07-06T19:55:00Z")]);

    const result = await syncHevyWorkouts(client, [workout("w1", START)], opts());

    expect(result).toMatchObject({ matched: 1, written: 1, unmatched: 0, created: 0 });
    const [id, fields] = client.updateActivity.mock.calls[0];
    expect(id).toBe("i1");
    expect(fields.description).toBe(`${MARKER}\nGoblet Squat: 2×8@44lb @RPE8`);
  });

  it("queries activities with a day of padding either side", async () => {
    const client = fakeClient([]);
    await syncHevyWorkouts(client, [workout("w1", START)], opts());
    expect(client.getActivities).toHaveBeenCalledWith("2026-07-05", "2026-07-07");
  });

  it("dry run reads descriptions but writes nothing", async () => {
    const client = fakeClient([strengthActivity("i1", "2026-07-06T19:55:00Z")]);

    const result = await syncHevyWorkouts(
      client,
      [workout("w1", START)],
      opts({ apply: false, createMissing: true }),
    );

    expect(result.matched).toBe(1);
    expect(client.getActivityDescription).toHaveBeenCalledWith("i1");
    expect(client.updateActivity).not.toHaveBeenCalled();
    expect(client.createManualActivity).not.toHaveBeenCalled();
  });

  it("leaves a hand-written description alone unless forced", async () => {
    const acts = [strengthActivity("i1", "2026-07-06T19:55:00Z")];
    const notes = { i1: "felt strong today" };

    const kept = fakeClient(acts, notes);
    expect((await syncHevyWorkouts(kept, [workout("w1", START)], opts())).skipped).toBe(1);
    expect(kept.updateActivity).not.toHaveBeenCalled();

    const forced = fakeClient(acts, notes);
    await syncHevyWorkouts(forced, [workout("w1", START)], opts({ force: true }));
    expect(forced.updateActivity).toHaveBeenCalledTimes(1);
  });

  it("overwrites a description it wrote itself", async () => {
    const client = fakeClient([strengthActivity("i1", "2026-07-06T19:55:00Z")], {
      i1: `${MARKER}\nold detail`,
    });
    const result = await syncHevyWorkouts(client, [workout("w1", START)], opts());
    expect(result.written).toBe(1);
  });

  it("ignores non-strength activities at the same time", async () => {
    const client = fakeClient([strengthActivity("ride", "2026-07-06T19:52:00Z", "Ride")]);
    const result = await syncHevyWorkouts(client, [workout("w1", START)], opts());
    expect(result.unmatched).toBe(1);
    expect(client.updateActivity).not.toHaveBeenCalled();
    expect(client.createManualActivity).not.toHaveBeenCalled();
  });

  it("creates a manual activity for an unmatched workout with createMissing", async () => {
    const client = fakeClient([]);
    const result = await syncHevyWorkouts(
      client,
      [workout("w1", START)],
      opts({ createMissing: true }),
    );

    expect(result.created).toBe(1);
    expect(client.createManualActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WeightTraining",
        external_id: "hevy-w1",
        moving_time: 45 * 60,
      }),
    );
  });

  it("does nothing for an empty workout list", async () => {
    const client = fakeClient([]);
    expect(await syncHevyWorkouts(client, [], opts())).toEqual({
      matched: 0,
      unmatched: 0,
      created: 0,
      skipped: 0,
      written: 0,
    });
    expect(client.getActivities).not.toHaveBeenCalled();
  });
});
