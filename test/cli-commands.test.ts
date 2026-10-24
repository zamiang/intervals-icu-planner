import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCheck, runPlan, runStatus, type PlannerClient } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { addLocalDays } from "../src/dates.js";
import type { Activity, Config, IntervalsEvent, WellnessEntry } from "../src/types.js";

// End-to-end tests for the CLI commands: real config loading, scheduling and
// event mapping, with only the Intervals.icu client faked. These cover the
// orchestration the Monday automation runs unattended — which windows are
// fetched, which days are left alone, and what happens when a push fails.

const TODAY = "2026-10-26"; // a Monday
const END = addLocalDays(TODAY, 6);

const BASE_YAML = `
weight_training:
  name: "Strength"
  duration_minutes: 45
  description: "Squat, hinge, press"

sweet_spot:
  name: "Sweet Spot"
  duration_minutes: 60
  description: "3x12min at {w:88-94}W"
`;

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-commands-"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function configFrom(extraYaml = ""): Promise<Config> {
  const file = path.join(tmpDir, `config-${Math.random().toString(36).slice(2)}.yaml`);
  await fs.writeFile(file, BASE_YAML + extraYaml, "utf8");
  return loadConfig(file);
}

// A month of settled wellness ending yesterday. TSB 10 reads "fresh".
function wellness(tsb = 10, extra: Partial<WellnessEntry> = {}): WellnessEntry[] {
  return Array.from({ length: 30 }, (_, i) => ({
    date: addLocalDays(TODAY, i - 30),
    ctl: 50,
    atl: 50 - tsb,
    tsb,
    ...extra,
  }));
}

function activity(date: string, overrides: Partial<Activity> = {}): Activity {
  return {
    id: `i${date}`,
    start_date_local: `${date}T07:00:00`,
    start_date: `${date}T11:00:00Z`,
    type: "Ride",
    icu_training_load: 60,
    icu_intensity: 0.7,
    icu_zone_times: [600, 2400, 300, 0, 0, 0, 0],
    icu_ss_time: null,
    ...overrides,
  };
}

// Overrides replace the defaults' vi.fn()s, so the defaults' Mock types are
// what callers see.
function fakeClient(overrides: Partial<PlannerClient> = {}) {
  const defaults = {
    getEvents: vi.fn<PlannerClient["getEvents"]>(async () => []),
    getActivities: vi.fn(async (): Promise<Activity[]> => []),
    getTrainingLoadRange: vi.fn(async () => wellness()),
    getTrainingLoad: vi.fn(async () => ({ ctl: 50, atl: 40, tsb: 10 })),
    getRideSportSettings: vi.fn(async () => ({ id: 1, ftp: 230, lthr: 160 })),
    updateSportSettings: vi.fn(async () => {}),
    getAthlete: vi.fn(async () => ({ heightCm: 180, dateOfBirth: "1985-01-01", sex: "M" })),
    createEvent: vi.fn(async (e: IntervalsEvent) => e),
  };
  return { ...defaults, ...overrides } as typeof defaults;
}

function capture() {
  const lines: string[] = [];
  return { lines, log: (msg: string) => lines.push(msg), text: () => lines.join("\n") };
}

const planOpts = (log: (msg: string) => void, dryRun = false) => ({
  today: TODAY,
  dryRun,
  localAthlete: null,
  log,
});

const createdEvents = (client: ReturnType<typeof fakeClient>): IntervalsEvent[] =>
  client.createEvent.mock.calls.map(([e]) => e);

describe("runPlan", () => {
  it("dry run plans the week but writes nothing", async () => {
    const client = fakeClient({
      getActivities: vi.fn(async () => [activity("2026-10-20", { icu_rolling_ftp: 240 })]),
    });
    const out = capture();

    const code = await runPlan(client, await configFrom(), planOpts(out.log, true));

    expect(code).toBe(0);
    expect(client.createEvent).not.toHaveBeenCalled();
    expect(client.updateSportSettings).not.toHaveBeenCalled();
    expect(out.text()).toContain("=== Weekly Plan ===");
    expect(out.text()).toContain("would update Intervals.icu FTP 230W -> 240W");
    expect(out.text()).toContain("(dry run — nothing pushed to Intervals.icu)");
  });

  it("pushes every non-rest workout inside the 7-day window", async () => {
    const client = fakeClient();
    const out = capture();

    const code = await runPlan(client, await configFrom(), planOpts(out.log));

    expect(code).toBe(0);
    const events = createdEvents(client);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.start_date_local).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00$/);
      const day = e.start_date_local.slice(0, 10);
      expect(day >= TODAY && day <= END).toBe(true);
      expect(e.category).not.toBe("NOTE"); // rest days are never pushed
    }
    expect(out.text()).toContain(`Done. Created ${events.length} event(s).`);
  });

  it("fetches the planning window, race horizon, and holiday lookback", async () => {
    const client = fakeClient();
    await runPlan(
      client,
      await configFrom(),
      planOpts(() => {}, true),
    );

    const windows = client.getEvents.mock.calls.map(([from, to]) => `${from}..${to}`);
    // min_weight_gap_days defaults to 2 → one day of pre-window lookback, so a
    // hard session yesterday can still block a hard placement today.
    expect(windows).toContain(`${addLocalDays(TODAY, -1)}..${END}`);
    expect(windows).toContain(`${TODAY}..${addLocalDays(TODAY, 364)}`);
    expect(windows).toContain(`${addLocalDays(TODAY, -60)}..${END}`);
  });

  it("renders watt placeholders from the synced FTP", async () => {
    const client = fakeClient({
      getActivities: vi.fn(async () => [activity("2026-10-20", { icu_rolling_ftp: 240 })]),
    });
    await runPlan(
      client,
      await configFrom(),
      planOpts(() => {}),
    );

    expect(client.updateSportSettings).toHaveBeenCalledWith(1, { ftp: 240 });
    const text = createdEvents(client)
      .map((e) => e.description ?? "")
      .join("\n");
    expect(text).not.toMatch(/\{(ftp|lthr|w|hr)/);
  });

  it("leaves days that already hold an event or a completed activity alone", async () => {
    const tuesday = addLocalDays(TODAY, 1);
    const client = fakeClient({
      getEvents: vi.fn(async (from: string) =>
        from === addLocalDays(TODAY, -1)
          ? [
              {
                id: 9,
                start_date_local: `${tuesday}T00:00:00`,
                name: "Group ride",
                category: "WORKOUT",
                type: "Ride",
              },
            ]
          : [],
      ),
      getActivities: vi.fn(async () => [activity(TODAY)]),
    });

    await runPlan(
      client,
      await configFrom(),
      planOpts(() => {}),
    );

    const days = createdEvents(client).map((e) => e.start_date_local.slice(0, 10));
    expect(days.length).toBeGreaterThan(0);
    expect(days).not.toContain(TODAY);
    expect(days).not.toContain(tuesday);
  });

  it("schedules nothing on days a holiday covers", async () => {
    const client = fakeClient({
      getEvents: vi.fn(async (from: string) =>
        from === addLocalDays(TODAY, -60)
          ? [
              {
                start_date_local: "2026-10-20T00:00:00",
                // Exclusive midnight end: covers through Thursday 10/29.
                end_date_local: "2026-10-30T00:00:00",
                name: "Trip",
                category: "HOLIDAY",
              },
            ]
          : [],
      ),
    });
    const out = capture();

    await runPlan(client, await configFrom(), planOpts(out.log));

    const days = createdEvents(client).map((e) => e.start_date_local.slice(0, 10));
    expect(days.every((d) => d >= "2026-10-30")).toBe(true);
    expect(out.text()).toContain("HOLIDAY: Trip — 4 day(s) this week left unplanned");
  });

  it("keeps pushing after a failure and exits 1", async () => {
    let calls = 0;
    const client = fakeClient({
      createEvent: vi.fn(async (e: IntervalsEvent) => {
        if (++calls === 1) throw new Error("Intervals.icu API error (500): boom");
        return e;
      }),
    });
    const out = capture();

    const code = await runPlan(client, await configFrom(), planOpts(out.log));

    expect(code).toBe(1);
    expect(client.createEvent.mock.calls.length).toBeGreaterThan(1);
    expect(out.text()).toContain("FAILED:");
    expect(out.text()).toMatch(/Created \d+, failed 1\./);
  });

  it("still pushes the plan when the fuelling profile lookup fails", async () => {
    const config = await configFrom(`
fueling:
  enabled: true
  start_date: "2026-10-01"
  end_date: "2026-12-31"
`);
    const client = fakeClient({
      getAthlete: vi.fn(async () => {
        throw new Error("Intervals.icu API error (503): down");
      }),
    });
    const out = capture();

    const code = await runPlan(client, config, planOpts(out.log));

    expect(code).toBe(0);
    expect(out.text()).toContain("Fuelling: could not read the Intervals.icu profile");
    expect(out.text()).toContain("Fuelling: skipped");
    expect(createdEvents(client).length).toBeGreaterThan(0);
  });

  it("pushes daily fuelling notes when the profile is complete", async () => {
    const config = await configFrom(`
fueling:
  enabled: true
  start_date: "2026-10-01"
  end_date: "2026-12-31"
`);
    const client = fakeClient({
      getTrainingLoadRange: vi.fn(async () => wellness(10, { weight: 76 })),
    });

    const code = await runPlan(client, config, {
      ...planOpts(() => {}),
      localAthlete: { heightCm: 180, dateOfBirth: "1985-01-01", sex: "M" },
    });

    expect(code).toBe(0);
    // The local file is complete, so the account profile is never asked.
    expect(client.getAthlete).not.toHaveBeenCalled();
    const notes = createdEvents(client).filter((e) => e.category === "NOTE");
    expect(notes.length).toBe(7);
    expect(notes.every((n) => n.name.startsWith("Fuel "))).toBe(true);
  });

  it("plans a lighter week when fatigued", async () => {
    const fresh = fakeClient();
    const tired = fakeClient({ getTrainingLoadRange: vi.fn(async () => wellness(-25)) });
    const config = await configFrom();

    await runPlan(
      fresh,
      config,
      planOpts(() => {}),
    );
    await runPlan(
      tired,
      config,
      planOpts(() => {}),
    );

    const load = (c: ReturnType<typeof fakeClient>) =>
      createdEvents(c).reduce((sum, e) => sum + (e.icu_training_load ?? 0), 0);
    expect(load(tired)).toBeLessThan(load(fresh));
  });
});

describe("runStatus", () => {
  it("prints the training status dashboard", async () => {
    const out = capture();
    await runStatus(fakeClient(), await configFrom(), { today: TODAY, json: false, log: out.log });

    expect(out.text()).toContain("=== Training Status ===");
    expect(out.text()).toContain("TSB (Form):     10");
    expect(out.text()).toContain("FTP:    230W");
  });

  it("emits machine-readable JSON with --json", async () => {
    const out = capture();
    const client = fakeClient({
      getActivities: vi.fn(async () => [activity("2026-10-20", { icu_rolling_ftp: 238 })]),
    });
    await runStatus(client, await configFrom(), { today: TODAY, json: true, log: out.log });

    const parsed = JSON.parse(out.text());
    expect(parsed.training_load).toEqual({ ctl: 50, atl: 40, tsb: 10 });
    expect(parsed.icu_ftp).toBe(230);
    expect(parsed.icu_eftp).toBe(238);
    expect(parsed.ramp).toMatchObject({ weekly_pct: 0, exceeds: false });
    expect(Object.keys(parsed.zones.deficits)).toEqual(Object.keys(parsed.zones.targets));
  });
});

describe("runCheck", () => {
  it("returns 0 when every pre-flight call succeeds", async () => {
    const out = capture();
    expect(await runCheck(fakeClient(), { today: TODAY, log: out.log })).toBe(0);
    expect(out.text()).toContain("All checks passed.");
  });

  it("returns 1 and names the failing call", async () => {
    const out = capture();
    const client = fakeClient({
      getRideSportSettings: vi.fn(async () => {
        throw new Error("Intervals.icu API error (401): bad key");
      }),
    });
    expect(await runCheck(client, { today: TODAY, log: out.log })).toBe(1);
    expect(out.text()).toContain("FAIL  Intervals.icu ride sport-settings — ");
    expect(out.text()).toContain("1 check(s) failed.");
  });
});
