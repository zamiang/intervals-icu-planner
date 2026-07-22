// Push an editable, hand-tuned week to the Intervals.icu calendar.
//
//   npm run push-week -- --dry-run                 # preview, write nothing
//   npm run push-week                              # push scripts/week-plan.yaml
//   npm run push-week -- --start 2026-06-08        # anchor to a specific Monday
//   npm run push-week -- --file other-plan.yaml    # use a different plan file
//   npm run push-week -- --replace                 # overwrite existing events
//
// Use this when the generated `npm run plan` isn't quite what you want and you
// want to schedule a specific week by hand. The plan file format is documented
// in scripts/week-plan.yaml. By default, days that already have a calendar
// event are skipped, so re-running is safe and never duplicates. Pass
// --replace to update those existing events in place instead (e.g. to push
// revised planned-load targets onto a week already on the calendar).
import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });
import { promises as fs } from "node:fs";
import { parse } from "yaml";
import { toLocalISODate, todayLocal, addLocalDays } from "../src/dates.js";
import { loadConfig } from "../src/config.js";
import { IntervalsClient } from "../src/intervals.js";
import { sweetSpotWorkout } from "../src/workout.js";
import { renderTargets, syncFtp } from "../src/ftp.js";
import { applyHolidayPolicy, holidayDatesInWindow } from "../src/holidays.js";
import type { Config, IntervalsEvent } from "../src/types.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface PlanSession {
  day: string | number;
  workout?: "sweet_spot" | "weight_training";
  name?: string;
  type?: string;
  description?: string;
  load?: number; // planned TSS — pushed to Intervals.icu as icu_training_load
  minutes?: number; // planned duration — pushed as moving_time (seconds)
  intensity?: number; // planned IF — pushed as icu_intensity
}

function parseFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// The Monday on or after the given date (or today). Anchoring to a Monday keeps
// `day: Tue` etc. unambiguous regardless of when the script is run.
function upcomingMonday(from = new Date()): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  if (dow !== 0) d.setDate(d.getDate() + (7 - dow));
  return d;
}

function offsetForDay(day: string | number): number {
  if (typeof day === "number") return day;
  const idx = WEEKDAYS.indexOf(day);
  if (idx < 0) throw new Error(`Unknown day "${day}" — use ${WEEKDAYS.join("/")} or a 0-6 offset`);
  return idx;
}

function dateStr(anchor: Date, offset: number): string {
  const d = new Date(anchor);
  d.setDate(d.getDate() + offset);
  return toLocalISODate(d);
}

// Attach optional planned-load targets (TSS / duration / IF) when the session
// supplies them, so Intervals.icu can show and forecast the planned workout.
function withPlannedLoad(event: IntervalsEvent, s: PlanSession): IntervalsEvent {
  if (typeof s.load === "number") event.icu_training_load = s.load;
  if (typeof s.minutes === "number") event.moving_time = Math.round(s.minutes * 60);
  if (typeof s.intensity === "number") event.icu_intensity = s.intensity;
  return event;
}

export function sessionToEvent(s: PlanSession, date: string, config: Config): IntervalsEvent {
  if (s.workout) {
    const def = config[s.workout];
    // The sweet-spot session has a fixed interval structure, so write it as an
    // Intervals.icu plain-text workout (target watts from FTP) rather than prose.
    const structured = s.workout === "sweet_spot" ? sweetSpotWorkout() : null;
    const event = withPlannedLoad(
      {
        start_date_local: `${date}T00:00:00`,
        name: def.name,
        category: "WORKOUT",
        type: s.workout === "weight_training" ? "WeightTraining" : "Ride",
        description: structured ? structured.text : def.description,
      },
      s,
    );
    // Duration follows the structured steps unless the session names its own.
    // The steps are then the source of truth, so recompute TSS from the
    // structured duration + IF (mirrors the cli.ts plan path) — otherwise a YAML
    // `load:` computed for the config duration would be stamped against the
    // longer structured duration. With no IF in the YAML we can't recompute, so
    // the explicit `load:` is left as a best effort.
    if (structured && s.minutes === undefined) {
      event.moving_time = Math.round(structured.minutes * 60);
      if (typeof s.intensity === "number") {
        event.icu_training_load = Math.round((structured.minutes / 60) * s.intensity ** 2 * 100);
      }
    } else if (!structured && s.minutes === undefined) {
      // Prose sessions (weights) fall back to the config duration. Without an
      // explicit moving_time Intervals.icu derives one by parsing the prose
      // description as a workout, and any duration-like token (e.g. a 37-inch
      // band written as `37"`) becomes a bogus seconds-long plan that the
      // completed activity then fails to auto-pair with.
      event.moving_time = Math.round(def.duration_minutes * 60);
    }
    return event;
  }
  if (!s.name || !s.type) {
    throw new Error(`Session on ${date} needs either a 'workout' or both 'name' and 'type'`);
  }
  return withPlannedLoad(
    {
      start_date_local: `${date}T00:00:00`,
      name: s.name,
      category: "WORKOUT",
      type: s.type,
      description: (s.description ?? "").trim(),
    },
    s,
  );
}

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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const replace = process.argv.includes("--replace");
  const file = parseFlag("file") ?? "scripts/week-plan.yaml";
  const startArg = parseFlag("start");
  const anchor = startArg ? upcomingMonday(new Date(`${startArg}T00:00:00`)) : upcomingMonday();

  const config = await loadConfig("config.yaml");
  const doc = parse(await fs.readFile(file, "utf8")) as { sessions?: PlanSession[] };
  const sessions = doc?.sessions ?? [];
  if (sessions.length === 0) throw new Error(`No sessions found in ${file}`);

  const events = sessions
    .map((s) => sessionToEvent(s, dateStr(anchor, offsetForDay(s.day)), config))
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));

  const oldest = events[0].start_date_local.slice(0, 10);
  const newest = events[events.length - 1].start_date_local.slice(0, 10);
  const anchorStr = dateStr(anchor, 0);

  const client = new IntervalsClient(process.env.INTERVALS_API_KEY!);
  const today = todayLocal();
  // The events fetch starts well before the week when holiday detection is on:
  // the events API filters on *start* date only, so a HOLIDAY that began weeks
  // ago and still covers this week would otherwise be invisible. Pre-week
  // events are harmless to planPushActions — its date keys can only match
  // events inside the planned week.
  const eventsOldest = config.holidays.enabled
    ? addLocalDays(oldest, -config.holidays.lookback_days)
    : oldest;
  const [fetchedEvents, rideSettings, activities] = await Promise.all([
    client.getEvents(eventsOldest, newest),
    client.getRideSportSettings(),
    // 30 days is plenty to find the latest ride carrying an eFTP estimate.
    client.getActivities(addLocalDays(today, -30), today),
  ]);
  const holidaySet = config.holidays.enabled
    ? holidayDatesInWindow(fetchedEvents, oldest, newest)
    : new Set<string>();
  // HOLIDAY events covered by the set drop out of the occupied-day/replace
  // bookkeeping: their days are handled by the holiday policy below, and under
  // --replace they must never be consumed as an update target (which would
  // overwrite the holiday banner itself).
  const existing = fetchedEvents.filter(
    (e) => !(e.category === "HOLIDAY" && holidaySet.has(e.start_date_local.slice(0, 10))),
  );

  // eFTP sync + placeholder rendering: descriptions in the plan file carry
  // {ftp}/{lthr}/{w:..}/{hr:..} placeholders instead of hardcoded watts; they
  // render from the (freshly synced) Intervals.icu sport settings.
  // Holiday policy first: sessions landing on holiday days are dropped (or
  // coalesced into one zero-load placeholder per day) before any push logic.
  // Days already holding a real event get no placeholder at all — under
  // --replace one would consume that event as an update target and overwrite
  // it with travel content.
  const occupiedDates = new Set(existing.map((e) => e.start_date_local.slice(0, 10)));
  const {
    events: pushEvents,
    dropped: holidayDropped,
    placeholderDates,
  } = applyHolidayPolicy(events, holidaySet, config.holidays.mode, occupiedDates);

  const renderValues = await syncFtp(client, rideSettings, activities, config.ftp_sync, { dryRun });
  for (const e of pushEvents) {
    if (e.description) e.description = renderTargets(e.description, renderValues);
  }

  const actions = planPushActions(pushEvents, existing, replace);

  console.log(
    `Week anchored to Monday ${anchorStr}${dryRun ? " — DRY RUN" : ""}${replace ? " — REPLACE" : ""}`,
  );
  for (const e of holidayDropped) {
    const date = e.start_date_local.slice(0, 10);
    const note = placeholderDates.has(date) ? "; placeholder pushed instead" : "";
    console.log(`  skip    ${date} — ${e.name} (holiday${note})`);
  }
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
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("push-week.ts") || process.argv[1].endsWith("push-week.js"));

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
