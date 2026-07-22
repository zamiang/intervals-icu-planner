import { describe, it, expect } from "vitest";
import { planPushActions, sessionToEvent } from "../scripts/push-week.js";
import { applyHolidayPolicy, HOLIDAY_PLACEHOLDER } from "../src/holidays.js";
import type { Config, IntervalsEvent } from "../src/types.js";

const ev = (date: string, name: string, id?: number): IntervalsEvent => ({
  ...(id !== undefined ? { id } : {}),
  start_date_local: `${date}T00:00:00`,
  name,
  category: "WORKOUT",
});

describe("planPushActions", () => {
  it("skips days that already have an event (default mode)", () => {
    const actions = planPushActions(
      [ev("2026-06-10", "New Ride")],
      [ev("2026-06-10", "Old", 1)],
      false,
    );
    expect(actions).toEqual([
      {
        kind: "skip",
        date: "2026-06-10",
        event: actions[0].event,
        reason: "day already has an event",
      },
    ]);
  });

  it("creates on empty days (default mode)", () => {
    const actions = planPushActions([ev("2026-06-10", "New Ride")], [], false);
    expect(actions[0].kind).toBe("create");
  });

  it("matches each session to a distinct existing event on a stacked day (--replace)", () => {
    const events = [ev("2026-06-10", "Hard Ride"), ev("2026-06-10", "Strength")];
    const existing = [ev("2026-06-10", "Old Ride", 11), ev("2026-06-10", "Old Lift", 22)];
    const actions = planPushActions(events, existing, true);
    expect(actions.map((a) => a.kind)).toEqual(["update", "update"]);
    expect(actions.map((a) => (a.kind === "update" ? a.priorId : null))).toEqual([11, 22]);
  });

  it("creates the overflow session when fewer existing events than sessions (--replace)", () => {
    const events = [ev("2026-06-10", "Hard Ride"), ev("2026-06-10", "Strength")];
    const existing = [ev("2026-06-10", "Old Ride", 11)];
    const actions = planPushActions(events, existing, true);
    expect(actions.map((a) => a.kind)).toEqual(["update", "create"]);
  });

  it("skips an existing event with no id under --replace", () => {
    const actions = planPushActions([ev("2026-06-10", "Ride")], [ev("2026-06-10", "Old")], true);
    expect(actions[0]).toMatchObject({
      kind: "skip",
      reason: "existing event has no id; cannot replace",
    });
  });
});

// The push-week holiday wiring, composed the way main() composes it:
// applyHolidayPolicy (fed the occupied-day set derived from existing events)
// runs before planPushActions decides create/update/skip.
describe("holiday policy → planPushActions composition", () => {
  const holidaySet = new Set(["2026-08-03", "2026-08-04"]);

  const runPolicy = (
    planned: IntervalsEvent[],
    existing: IntervalsEvent[],
    mode: "skip" | "placeholder",
    replace: boolean,
  ) => {
    const occupied = new Set(existing.map((e) => e.start_date_local.slice(0, 10)));
    const { events, dropped } = applyHolidayPolicy(planned, holidaySet, mode, occupied);
    return { actions: planPushActions(events, existing, replace), dropped };
  };

  it("never lets a placeholder overwrite a real event under --replace", () => {
    // Scenario from real life: a ride was pushed before the trip landed on the
    // calendar. Re-pushing the week with --replace must not consume that ride
    // as an update target and rewrite it into a zero-load travel entry.
    const planned = [ev("2026-08-03", "Sweet Spot Intervals"), ev("2026-08-05", "Easy Ride")];
    const existing = [ev("2026-08-03", "Previously Pushed Ride", 42)];
    const { actions, dropped } = runPolicy(planned, existing, "placeholder", true);

    expect(dropped.map((e) => e.name)).toEqual(["Sweet Spot Intervals"]);
    // No action may target the pre-existing event's id, and no placeholder
    // reaches the push at all for the occupied day.
    expect(actions.filter((a) => a.kind === "update")).toEqual([]);
    expect(actions.map((a) => [a.kind, a.date, a.event.name])).toEqual([
      ["create", "2026-08-05", "Easy Ride"],
    ]);
  });

  it("creates a placeholder only on empty holiday days", () => {
    const planned = [ev("2026-08-03", "Sweet Spot Intervals"), ev("2026-08-04", "Easy Ride")];
    const existing = [ev("2026-08-03", "Previously Pushed Ride", 42)];
    const { actions } = runPolicy(planned, existing, "placeholder", false);
    expect(actions.map((a) => [a.kind, a.date, a.event.name])).toEqual([
      ["create", "2026-08-04", HOLIDAY_PLACEHOLDER.name],
    ]);
  });

  it("pushes nothing on holiday days in skip mode", () => {
    const planned = [ev("2026-08-03", "Sweet Spot Intervals"), ev("2026-08-05", "Easy Ride")];
    const { actions, dropped } = runPolicy(planned, [], "skip", true);
    expect(dropped).toHaveLength(1);
    expect(actions.map((a) => [a.kind, a.date])).toEqual([["create", "2026-08-05"]]);
  });
});

describe("sessionToEvent", () => {
  const config = {
    sweet_spot: {
      name: "Sweet Spot Intervals",
      duration_minutes: 60,
      description: "long prose rationale",
    },
    weight_training: {
      name: "Cyclist Strength Routine",
      duration_minutes: 60,
      description: "lift heavy",
    },
  } as unknown as Config;

  it("renders the sweet-spot workout as power-targeted structured steps", () => {
    const event = sessionToEvent({ day: "Wed", workout: "sweet_spot" }, "2026-06-10", config);
    expect(event.description).toContain("88-94%");
    expect(event.description).not.toContain("long prose rationale");
    // No explicit minutes in the session → duration follows the structured steps.
    expect(event.moving_time).toBe(72 * 60);
  });

  it("recomputes TSS from the structured duration when the session gives an IF", () => {
    // YAML `load: 77` was computed for the 60-min config value; with a structured
    // 72-min workout the steps win, so TSS is recomputed from IF, not left at 77.
    const event = sessionToEvent(
      { day: "Wed", workout: "sweet_spot", load: 77, intensity: 0.88 },
      "2026-06-10",
      config,
    );
    expect(event.moving_time).toBe(72 * 60);
    expect(event.icu_training_load).toBe(Math.round((72 / 60) * 0.88 ** 2 * 100));
  });

  it("leaves an explicit load as a best effort when no IF is supplied", () => {
    // No IF to recompute from, so the YAML load is kept even though the
    // structured duration differs — documented best-effort behavior.
    const event = sessionToEvent(
      { day: "Wed", workout: "sweet_spot", load: 77 },
      "2026-06-10",
      config,
    );
    expect(event.moving_time).toBe(72 * 60);
    expect(event.icu_training_load).toBe(77);
  });

  it("gives weight sessions the config duration as moving_time", () => {
    // Regression guard: without an explicit moving_time, Intervals.icu derives
    // one by parsing the prose description as a workout — duration-like tokens
    // (e.g. a 37-inch band written as `37"`) produced a bogus seconds-long
    // plan that the completed activity failed to auto-pair with (0% compliance).
    const event = sessionToEvent({ day: "Mon", workout: "weight_training" }, "2026-06-10", config);
    expect(event.type).toBe("WeightTraining");
    expect(event.moving_time).toBe(60 * 60);
  });

  it("keeps explicit session minutes when supplied", () => {
    const event = sessionToEvent(
      { day: "Wed", workout: "sweet_spot", minutes: 65 },
      "2026-06-10",
      config,
    );
    expect(event.moving_time).toBe(65 * 60);
  });

  it("leaves weight_training as its prose description", () => {
    const event = sessionToEvent({ day: "Mon", workout: "weight_training" }, "2026-06-08", config);
    expect(event.description).toBe("lift heavy");
  });
});
