# API & Date Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the workout-planner's network and date boundaries so a malformed API response, an uncomputed wellness day, a partial push, a stacked-day replace, a timezone-shifted host, or a missing Xert token can no longer silently produce a wrong plan or crash.

**Architecture:** Six independent hardening changes. Network responses get the same defensive coercion already used by `getActivities`. Training load is derived from the most recent _populated_ wellness entry instead of a possibly-empty single day. The plan push becomes fault-tolerant (reconcile, don't abort). `push-week --replace` matches existing events per-event so stacked days don't clobber each other. All CLI/script date math routes through one host-local helper module. Xert auth fails loudly when no token comes back.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, `tsx` runner, `yaml`, Intervals.icu + Xert REST APIs.

**Decisions locked (from review):**

- Item #2 (partial push): **reconciliation only** — collect successes/failures, print a summary, exit non-zero on any failure. No in-client retry/backoff.
- Item #5 (timezone): **host-local** — a single `todayLocal()`/`addLocalDays()` helper using the machine's local calendar day.

**Baseline:** `npm run typecheck` clean, `npm test` = 128 passing. Re-confirm green before starting.

---

## File Structure

- `src/intervals.ts` — add `parseEvent` coercion; `getEvents` returns validated events (Task 1).
- `src/types.ts` — add `category?: string` to `IntervalsEvent` (Task 1).
- `src/cli.ts` — add `latestTrainingLoad` + use it (Task 2); extract testable `pushPlan` (Task 3); route dates through the new helper (Task 5).
- `src/dates.ts` — **new** host-local date helpers (Task 5).
- `src/xert.ts` — assert `access_token` present (Task 6).
- `scripts/push-week.ts` — extract `planPushActions`, fix stacked-day replace, add `isMain` guard, host-local dates (Tasks 4, 5).
- `scripts/events.ts` — host-local dates (Task 5).
- `test/intervals.test.ts`, `test/cli.test.ts`, `test/xert.test.ts`, `test/dates.test.ts` (new), `test/push-week.test.ts` (new).

---

## Task 1: Validate `getEvents` responses

**Why:** `getEvents` casts raw `res.json()` straight to `IntervalsEvent[]`. A single event missing `start_date_local` crashes `scheduler.ts` (`dayKey(...).slice`) and `cli.ts resolveRaceDate`. `category` is read in `resolveRaceDate` but isn't even on the type.

**Files:**

- Modify: `src/types.ts` (add `category` field)
- Modify: `src/intervals.ts` (add `parseEvent`, use in `getEvents`)
- Test: `test/intervals.test.ts`

- [ ] **Step 1: Add `category` to the `IntervalsEvent` type**

In `src/types.ts`, inside `interface IntervalsEvent`, add the field after `name`:

```typescript
  name: string;
  category?: string; // "WORKOUT", "NOTE", "RACE_A", etc. (read for race detection)
```

- [ ] **Step 2: Write the failing test**

Add to `test/intervals.test.ts` inside the `describe("getEvents", ...)` block:

```typescript
it("coerces malformed events and drops entries with no date", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [
      { id: 1, start_date_local: "2026-04-20", name: "Ride", category: "WORKOUT", type: "Ride" },
      { name: "no date — should be dropped", category: "WORKOUT" },
      { id: "not-a-number", start_date_local: "2026-04-21", category: "RACE_A" },
    ],
  });

  const events = await client.getEvents("2026-04-20", "2026-04-26");

  expect(events).toHaveLength(2);
  expect(events[0].start_date_local).toBe("2026-04-20");
  expect(events[1]).toMatchObject({ start_date_local: "2026-04-21", category: "RACE_A" });
  expect(events[1].id).toBeUndefined(); // non-numeric id coerced away
  expect(events[1].name).toBe(""); // missing name coerced to ""
});

it("returns empty array when the response is not an array", async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ error: "boom" }) });
  const events = await client.getEvents("2026-04-20", "2026-04-26");
  expect(events).toEqual([]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/intervals.test.ts -t "coerces malformed"`
Expected: FAIL (current `getEvents` returns raw objects; the malformed entry is not dropped, `id` stays `"not-a-number"`).

- [ ] **Step 4: Add the `parseEvent` helper**

In `src/intervals.ts`, add this function just below `parseWellnessEntry` (before the `IntervalsClient` class):

```typescript
function parseEvent(raw: unknown): IntervalsEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.start_date_local !== "string" || e.start_date_local === "") return null;
  return {
    ...(typeof e.id === "number" ? { id: e.id } : {}),
    start_date_local: e.start_date_local,
    name: typeof e.name === "string" ? e.name : "",
    ...(typeof e.category === "string" ? { category: e.category } : {}),
    ...(typeof e.description === "string" ? { description: e.description } : {}),
    ...(typeof e.type === "string" ? { type: e.type } : {}),
    ...(typeof e.icu_training_load === "number" ? { icu_training_load: e.icu_training_load } : {}),
    ...(typeof e.moving_time === "number" ? { moving_time: e.moving_time } : {}),
    ...(typeof e.icu_intensity === "number" ? { icu_intensity: e.icu_intensity } : {}),
  };
}
```

Also add `IntervalsEvent` to the type import at the top of the file if not already present — it is already imported (`import type { Activity, IntervalsEvent, TrainingLoad, WellnessEntry } from "./types.js";`), so no change needed.

- [ ] **Step 5: Use `parseEvent` in `getEvents`**

In `src/intervals.ts`, replace the body of `getEvents` after the `res.ok` check:

```typescript
if (!res.ok) {
  throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
}
const data = await res.json();
if (!Array.isArray(data)) return [];
return data.map(parseEvent).filter((e): e is IntervalsEvent => e !== null);
```

- [ ] **Step 6: Run the full intervals + cli suites**

Run: `npx vitest run test/intervals.test.ts test/cli.test.ts`
Expected: PASS (including the pre-existing `"fetches events for a date range"` test — `toEqual` ignores the absent optional keys).

- [ ] **Step 7: Typecheck & commit**

```bash
npm run typecheck
git add src/intervals.ts src/types.ts test/intervals.test.ts
git commit -m "harden: validate Intervals.icu getEvents responses, type category field"
```

---

## Task 2: Derive training load from the latest populated wellness entry

**Why:** `getTrainingLoad(today)` returns `{ctl:0, atl:0, tsb:0}` when today's wellness isn't computed yet (common before a sync). `classifyFatigue(0)` then silently reports "moderate" on phantom zero-fitness. Both `status` and `plan` already fetch a trailing `wellnessRange`; derive the load from its most recent populated entry instead.

**Files:**

- Modify: `src/cli.ts` (add `latestTrainingLoad`, use it in `status` and `plan`, drop the redundant `getTrainingLoad(today)` calls)
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/cli.test.ts`. First extend the import on line 2–9 to include `latestTrainingLoad`:

```typescript
import {
  parseArgs,
  formatPlan,
  workoutToEvent,
  computeWeeklyRampPct,
  resolveRaceDate,
  weeksUntil,
  latestTrainingLoad,
} from "../src/cli.js";
```

Then add a new describe block at the end of the file:

```typescript
describe("latestTrainingLoad", () => {
  it("picks the most recent entry with a populated CTL", () => {
    const range: WellnessEntry[] = [
      { date: "2026-06-07", ctl: 55, atl: 60, tsb: -5 },
      { date: "2026-06-08", ctl: 56, atl: 58, tsb: -2 },
      { date: "2026-06-09", ctl: 0, atl: 0, tsb: 0 }, // today, not computed yet
    ];
    expect(latestTrainingLoad(range)).toEqual({ ctl: 56, atl: 58, tsb: -2 });
  });

  it("returns zeros when nothing is populated", () => {
    expect(latestTrainingLoad([{ date: "2026-06-09", ctl: 0, atl: 0, tsb: 0 }])).toEqual({
      ctl: 0,
      atl: 0,
      tsb: 0,
    });
  });

  it("returns zeros for an empty range", () => {
    expect(latestTrainingLoad([])).toEqual({ ctl: 0, atl: 0, tsb: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.ts -t "latestTrainingLoad"`
Expected: FAIL with "latestTrainingLoad is not a function" / import error.

- [ ] **Step 3: Implement `latestTrainingLoad`**

In `src/cli.ts`, add the `TrainingLoad` type to the existing type import (line 8):

```typescript
import type {
  PlannedWorkout,
  IntervalsEvent,
  WellnessEntry,
  WorkoutType,
  TrainingLoad,
} from "./types.js";
```

Add the function just below `computeWeeklyRampPct` (after line 45):

```typescript
// Most recent wellness entry with a populated CTL. Intervals.icu may return
// today's entry with CTL 0 before activities sync, so reading a single day can
// silently report zero fitness — fall back to the last day that actually has data.
export function latestTrainingLoad(range: WellnessEntry[]): TrainingLoad {
  const populated = range.filter((e) => e.ctl > 0).sort((a, b) => a.date.localeCompare(b.date));
  const pick = populated[populated.length - 1];
  if (!pick) return { ctl: 0, atl: 0, tsb: 0 };
  return { ctl: pick.ctl, atl: pick.atl, tsb: pick.tsb };
}
```

- [ ] **Step 4: Use it in the `status` command, dropping the redundant fetch**

In `src/cli.ts`, in the `status` branch, change the `Promise.all` (currently fetches `getTrainingLoad(today)` as the first element) to drop it, and derive `load` afterward:

```typescript
const [info, activities, wellnessRange] = await Promise.all([
  xert.getTrainingInfo(),
  intervals.getActivities(lookbackStr, today),
  intervals.getTrainingLoadRange(weekAgoStr, today),
]);
const load = latestTrainingLoad(wellnessRange);
const distribution = computeDistribution(activities);
const rampRatePct = computeWeeklyRampPct(wellnessRange);
```

- [ ] **Step 5: Use it in the `plan` command, dropping the redundant fetch**

In `src/cli.ts`, in the `plan` branch, change the `Promise.all` to drop `getTrainingLoad(today)` and derive `load` afterward:

```typescript
const [events, info, activities, wellnessRange, raceEvents] = await Promise.all([
  intervals.getEvents(today, endStr),
  xert.getTrainingInfo(),
  intervals.getActivities(lookbackStr, today),
  intervals.getTrainingLoadRange(weekAgoStr, today),
  intervals.getEvents(today, raceHorizonStr),
]);
const load = latestTrainingLoad(wellnessRange);
```

- [ ] **Step 6: Run typecheck and the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, 131 tests. (`getTrainingLoad` is still used by the `check` smoke test, so it stays on the client.)

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "harden: derive training load from latest populated wellness entry"
```

---

## Task 3: Make the plan push fault-tolerant (reconciliation)

**Why:** The push loop `await intervals.createEvent(...)` aborts on the first failure via `main().catch`, leaving the calendar half-written with no summary. Extract a testable `pushPlan` that records per-event success/failure, keeps going, and reports a reconciliation summary.

**Files:**

- Modify: `src/cli.ts` (add `pushPlan`, use it in `main`)
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Add `pushPlan` to the `test/cli.test.ts` import list, then add this describe block:

```typescript
describe("pushPlan", () => {
  const plan: PlannedWorkout[] = [
    {
      date: "2026-06-08",
      type: "cycling",
      name: "Easy Ride",
      description: "z2",
      intensity: "easy",
    },
    { date: "2026-06-09", type: "rest", name: "Rest Day", description: "off", intensity: "easy" },
    {
      date: "2026-06-10",
      type: "weights",
      name: "Strength",
      description: "lift",
      intensity: "hard",
    },
  ];

  it("skips rest days and pushes the rest", async () => {
    const createEvent = vi.fn().mockResolvedValue({});
    const result = await pushPlan({ createEvent }, plan, () => {});
    expect(createEvent).toHaveBeenCalledTimes(2); // rest day skipped
    expect(result.created).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it("records failures and keeps going", async () => {
    const createEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 boom"))
      .mockResolvedValueOnce({});
    const result = await pushPlan({ createEvent }, plan, () => {});
    expect(createEvent).toHaveBeenCalledTimes(2);
    expect(result.created).toHaveLength(1);
    expect(result.failed).toEqual([{ date: "2026-06-08", name: "Easy Ride", error: "503 boom" }]);
  });
});
```

Add `vi` to the vitest import at the top of `test/cli.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.ts -t "pushPlan"`
Expected: FAIL with "pushPlan is not a function".

- [ ] **Step 3: Implement `pushPlan`**

In `src/cli.ts`, add after `workoutToEvent` (after line 133). Note it depends only on a `createEvent` method, so it takes a structural type:

```typescript
export interface PushResult {
  created: string[];
  failed: { date: string; name: string; error: string }[];
}

// Push every non-rest workout, recording outcomes instead of aborting on the
// first failure. Re-running is safe — days that landed are locked as existing
// events and skipped next time — so the caller just needs to know what to retry.
export async function pushPlan(
  intervals: { createEvent: (e: IntervalsEvent) => Promise<unknown> },
  planned: PlannedWorkout[],
  log: (msg: string) => void = console.log,
): Promise<PushResult> {
  const created: string[] = [];
  const failed: PushResult["failed"] = [];
  for (const w of planned) {
    if (w.type === "rest") continue; // don't push rest days
    try {
      await intervals.createEvent(workoutToEvent(w));
      created.push(`${w.date} — ${w.name}`);
      log(`  Created: ${w.date} — ${w.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ date: w.date, name: w.name, error: msg });
      log(`  FAILED:  ${w.date} — ${w.name} — ${msg}`);
    }
  }
  return { created, failed };
}
```

- [ ] **Step 4: Use `pushPlan` in `main`**

In `src/cli.ts`, replace the existing push loop (the `console.log("Pushing to Intervals.icu...")` block through `console.log("Done.")`) with:

```typescript
console.log("Pushing to Intervals.icu...");
const { created, failed } = await pushPlan(intervals, planned);
if (failed.length === 0) {
  console.log(`Done. Created ${created.length} event(s).`);
} else {
  console.log(
    `Created ${created.length}, failed ${failed.length}. ` +
      `Re-run to retry the failed days — events already created are skipped.`,
  );
  process.exitCode = 1;
}
```

- [ ] **Step 5: Run typecheck and the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, 133 tests.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "harden: reconcile plan push failures instead of aborting on first error"
```

---

## Task 4: Fix `push-week --replace` clobbering stacked days

**Why:** `existingByDate` keeps only the first event per date, so two sessions on one day (hard ride + weights) both resolve to the same existing event; under `--replace` the second overwrites the first and one session is lost. Extract the match logic into a pure, testable `planPushActions` that consumes existing events per-day, and guard `main()` so the module can be imported in tests.

**Files:**

- Modify: `scripts/push-week.ts` (add `planPushActions`, rewrite the loop, add `isMain` guard)
- Test: `test/push-week.test.ts` (new)

- [ ] **Step 1: Add the `isMain` guard so the script is importable**

In `scripts/push-week.ts`, replace the final `main().catch(...)` block (lines 162–165) with:

```typescript
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  process.argv[1].endsWith("push-week.ts");

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

- [ ] **Step 2: Write the failing test**

Create `test/push-week.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { planPushActions } from "../scripts/push-week.js";
import type { IntervalsEvent } from "../src/types.js";

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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/push-week.test.ts`
Expected: FAIL with "planPushActions is not a function".

- [ ] **Step 4: Implement `planPushActions`**

In `scripts/push-week.ts`, add the exported type and function above `main` (after `sessionToEvent`, before `async function main`):

```typescript
export type PushAction =
  | { kind: "create"; date: string; event: IntervalsEvent }
  | { kind: "update"; date: string; event: IntervalsEvent; priorId: number }
  | { kind: "skip"; date: string; event: IntervalsEvent; reason: string };

// Decide create/update/skip per planned event. Default mode skips any day that
// already holds an event. --replace consumes existing events one-per-session, so
// two sessions stacked on one day map to two distinct existing events (or create
// the overflow) instead of both overwriting the first.
export function planPushActions(
  events: IntervalsEvent[],
  existing: IntervalsEvent[],
  replace: boolean,
): PushAction[] {
  const existingDates = new Set(existing.map((e) => e.start_date_local.slice(0, 10)));
  const queue = new Map<string, IntervalsEvent[]>();
  for (const e of existing) {
    const date = e.start_date_local.slice(0, 10);
    const arr = queue.get(date) ?? [];
    arr.push(e);
    queue.set(date, arr);
  }
  const actions: PushAction[] = [];
  for (const event of events) {
    const date = event.start_date_local.slice(0, 10);
    if (!replace) {
      if (existingDates.has(date)) {
        actions.push({ kind: "skip", date, event, reason: "day already has an event" });
      } else {
        actions.push({ kind: "create", date, event });
      }
      continue;
    }
    const prior = queue.get(date)?.shift();
    if (!prior) {
      actions.push({ kind: "create", date, event });
    } else if (typeof prior.id !== "number") {
      actions.push({
        kind: "skip",
        date,
        event,
        reason: "existing event has no id; cannot replace",
      });
    } else {
      actions.push({ kind: "update", date, event, priorId: prior.id });
    }
  }
  return actions;
}
```

- [ ] **Step 5: Rewrite `main`'s execution loop to use `planPushActions`**

In `scripts/push-week.ts`, replace the block from `// First existing event per day...` (the `existingByDate` map build) and the entire `for (const e of events)` loop with:

```typescript
const actions = planPushActions(events, existing, replace);

console.log(
  `Week anchored to Monday ${anchorStr}${dryRun ? " — DRY RUN" : ""}${replace ? " — REPLACE" : ""}`,
);
for (const action of actions) {
  const { date, event: e } = action;
  const load = typeof e.icu_training_load === "number" ? `, ${e.icu_training_load} TSS` : "";
  if (action.kind === "skip") {
    console.log(`  skip    ${date} — ${e.name} (${action.reason})`);
    continue;
  }
  if (dryRun) {
    const verb = action.kind === "update" ? "update " : "would  ";
    console.log(`  ${verb} ${date} — ${e.name} (${e.type}${load})`);
    continue;
  }
  if (action.kind === "update") {
    await client.updateEvent(action.priorId, e);
    console.log(`  updated ${date} — ${e.name} (${e.type}${load})`);
  } else {
    await client.createEvent(e);
    console.log(`  created ${date} — ${e.name} (${e.type}${load})`);
  }
}
console.log(dryRun ? "Dry run — nothing pushed." : "Done.");
```

The `client.getEvents(oldest, newest)` call that produces `existing` stays as-is, immediately before this block.

- [ ] **Step 6: Run the test and typecheck**

Run: `npx vitest run test/push-week.test.ts && npm run typecheck`
Expected: PASS. (Importing `scripts/push-week.js` no longer triggers `main()` because of the `isMain` guard — confirm the test run does not hit the network or exit.)

- [ ] **Step 7: Commit**

```bash
git add scripts/push-week.ts test/push-week.test.ts
git commit -m "fix: push-week --replace no longer clobbers stacked days; add isMain guard"
```

---

## Task 5: Route all CLI/script dates through a host-local helper

**Why:** `cli.ts` derives `today` from `new Date().toISOString().slice(0,10)` (UTC) but parses display dates as local, and lookback windows call `.toISOString()` on a _local_ `Date`, which applies the timezone offset. On non-UTC hosts the planning window, `completedDates` filtering, and `push-week` anchoring can shift by a day. Standardize on the host-local calendar day.

**Files:**

- Create: `src/dates.ts`
- Modify: `src/cli.ts`, `scripts/events.ts`, `scripts/push-week.ts`
- Test: `test/dates.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/dates.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { toLocalISODate, addLocalDays } from "../src/dates.js";

describe("toLocalISODate", () => {
  it("formats a Date as its local YYYY-MM-DD", () => {
    // Construct from local components so the assertion is timezone-independent.
    expect(toLocalISODate(new Date(2026, 5, 9))).toBe("2026-06-09"); // month is 0-based
  });

  it("zero-pads month and day", () => {
    expect(toLocalISODate(new Date(2026, 0, 3))).toBe("2026-01-03");
  });
});

describe("addLocalDays", () => {
  it("advances across a month boundary", () => {
    expect(addLocalDays("2026-06-29", 6)).toBe("2026-07-05");
  });

  it("goes backwards with a negative offset", () => {
    expect(addLocalDays("2026-06-09", -7)).toBe("2026-06-02");
  });

  it("is a no-op for zero", () => {
    expect(addLocalDays("2026-06-09", 0)).toBe("2026-06-09");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/dates.test.ts`
Expected: FAIL with module-not-found for `../src/dates.js`.

- [ ] **Step 3: Create `src/dates.ts`**

```typescript
// Host-local calendar dates. The planner reasons about the day the athlete is
// actually living in — using UTC (via toISOString) can roll "today" to tomorrow
// late in the evening on negative-offset hosts, shifting the whole window.

export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayLocal(): string {
  return toLocalISODate(new Date());
}

// Pure string-date arithmetic anchored at local midnight, returning a local
// YYYY-MM-DD. Safe across month/year boundaries and DST (date-only).
export function addLocalDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalISODate(d);
}
```

- [ ] **Step 4: Run the dates test to verify it passes**

Run: `npx vitest run test/dates.test.ts`
Expected: PASS.

- [ ] **Step 5: Use the helpers in `src/cli.ts`**

In `src/cli.ts`, add the import near the top (after the `./xert.js` import):

```typescript
import { todayLocal, addLocalDays } from "./dates.js";
```

Replace the date derivations:

- In `runCheck`: `const today = new Date().toISOString().slice(0, 10);` → `const today = todayLocal();`
- In the `status` branch, replace the five date lines:

```typescript
const today = todayLocal();
const lookbackStr = addLocalDays(today, -28);
const weekAgoStr = addLocalDays(today, -7);
```

(Delete the now-unused `lookbackStart` / `weekAgo` `Date` objects.)

- In the `plan` branch, replace the date setup block:

```typescript
const today = todayLocal();
const endStr = addLocalDays(today, 6);
const raceHorizonStr = addLocalDays(today, 364);
const lookbackStr = addLocalDays(today, -28);
const weekAgoStr = addLocalDays(today, -7);
```

(Delete the `endDate`, `raceHorizon`, `lookbackStart`, `weekAgo` `Date` objects.)

- [ ] **Step 6: Use the helpers in `scripts/events.ts`**

In `scripts/events.ts`, replace the local `addDays` function and the `today` derivation with imports. Add after the dotenv import:

```typescript
import { todayLocal, addLocalDays } from "../src/dates.js";
```

Delete the local `addDays` function (lines 12–16) and change:

```typescript
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const oldest = args[0] ?? todayLocal();
const newest = args[1] ?? addLocalDays(oldest, 6);
```

- [ ] **Step 7: Use the helper in `scripts/push-week.ts`'s `dateStr`**

In `scripts/push-week.ts`, add the import after the `yaml` import:

```typescript
import { toLocalISODate } from "../src/dates.js";
```

Replace the body of `dateStr` (which currently uses `.toISOString().slice(0, 10)`):

```typescript
function dateStr(anchor: Date, offset: number): string {
  const d = new Date(anchor);
  d.setDate(d.getDate() + offset);
  return toLocalISODate(d);
}
```

(`upcomingMonday` already builds a local-midnight `Date`, so feeding it through `toLocalISODate` is correct.)

- [ ] **Step 8: Run typecheck and the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, 139 tests. Also run `npm run lint` (covers `src/` and `test/`) — expect clean.

- [ ] **Step 9: Commit**

```bash
git add src/dates.ts src/cli.ts scripts/events.ts scripts/push-week.ts test/dates.test.ts
git commit -m "harden: route all CLI/script dates through a host-local helper"
```

---

## Task 6: Fail loudly when Xert returns no access token

**Why:** `authenticate` sets `this.accessToken = data.access_token` without checking. A shape change yields `undefined`, and the next call sends `Bearer undefined` and fails with a confusing 401 instead of a clear auth error.

**Files:**

- Modify: `src/xert.ts`
- Test: `test/xert.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/xert.test.ts` inside `describe("authenticate", ...)`:

```typescript
it("throws when the response has no access_token", async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ token_type: "Bearer" }) });
  await expect(client.authenticate()).rejects.toThrow("no access_token");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/xert.test.ts -t "no access_token"`
Expected: FAIL (currently sets `accessToken = undefined` and resolves without throwing).

- [ ] **Step 3: Add the guard in `authenticate`**

In `src/xert.ts`, replace the tail of `authenticate` (the `const data = await res.json(); this.accessToken = data.access_token;` lines):

```typescript
const data = await res.json();
if (!data || typeof data.access_token !== "string") {
  throw new Error("Xert auth succeeded but the response had no access_token");
}
this.accessToken = data.access_token;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/xert.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck & commit**

```bash
npm run typecheck
git add src/xert.ts test/xert.test.ts
git commit -m "harden: Xert authenticate throws when no access_token is returned"
```

---

## Final verification

- [ ] **Run the full gate exactly as CI does**

```bash
npm run format:check && npm run lint && npm run typecheck && npm test
```

Expected: all pass; ~139 tests green.

- [ ] **Manual smoke (optional, needs real `.env`)**

```bash
npm run plan -- --dry-run
```

Expected: prints a plan; the TSB line reflects the latest populated wellness day (not 0.0 unless genuinely new), and no push happens.

---

## Self-Review Notes

- **Coverage vs. review items:** Task 1 → high #1; Task 2 → high #3; Task 3 → high #2 (reconciliation-only, per decision); Task 4 → medium #4; Task 5 → medium #5 (host-local, per decision); Task 6 → medium #6. All high + medium items covered. (Low/polish items — flag validation, error-body logging — deliberately out of scope.)
- **Type consistency:** `PushResult`, `pushPlan`, `latestTrainingLoad`, `PushAction`, `planPushActions`, `toLocalISODate`, `addLocalDays`, `todayLocal` are each defined once and referenced with matching signatures.
- **`getTrainingLoad` retained:** still used by the `check` smoke test; Task 2 only removes its use from `status`/`plan`.
- **Existing `getEvents` test:** `toEqual(MOCK_EVENTS)` still passes because vitest's `toEqual` ignores absent optional keys and `parseEvent` omits (rather than sets `undefined` on) missing optionals.
