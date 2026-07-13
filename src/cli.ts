import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });
import { loadConfig } from "./config.js";
import { IntervalsClient } from "./intervals.js";
import { XertClient } from "./xert.js";
import { schedule, classifyFatigue, effectiveFatigue, rampGuardTriggered } from "./scheduler.js";
import { computeReadiness, type ReadinessSignal } from "./readiness.js";
import { todayLocal, addLocalDays } from "./dates.js";
import { computeDistribution, POLARIZED_TARGETS, ZONES, zoneLabel } from "./zones.js";
import { structuredWorkoutFor } from "./workout.js";
import { latestEftp, renderTargets, syncFtp } from "./ftp.js";
import type {
  PlannedWorkout,
  IntervalsEvent,
  WellnessEntry,
  WorkoutType,
  TrainingLoad,
} from "./types.js";

// Earliest future A-priority race date (YYYY-MM-DD) from calendar events, else
// the configured race_date fallback, else undefined when no race is known.
export function resolveRaceDate(
  events: IntervalsEvent[],
  today: string,
  raceDateFallback: string | null,
): string | undefined {
  const races = events
    .filter((e) => e.category === "RACE_A")
    .map((e) => e.start_date_local.slice(0, 10))
    .filter((d) => d >= today)
    .sort();
  if (races.length > 0) return races[0];
  if (raceDateFallback && raceDateFallback.slice(0, 10) >= today) {
    return raceDateFallback.slice(0, 10);
  }
  return undefined;
}

// Whole weeks from `today` until `raceDate`, rounded up (a partial week counts).
export function weeksUntil(today: string, raceDate: string): number {
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = new Date(raceDate + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime();
  return Math.ceil(diff / (7 * dayMs));
}

// CTL ramp = (newest - oldest) / oldest * 100 over the populated wellness days.
// Entries with ctl <= 0 are dropped first — Intervals.icu may return today's
// entry zeroed before activities sync, and using it as the newest endpoint would
// report a spurious ~-100% ramp. Needs at least two real datapoints; returns
// undefined otherwise (new athlete, gap in syncing, or only today present).
export function computeWeeklyRampPct(range: WellnessEntry[]): number | undefined {
  const populated = range.filter((e) => e.ctl > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (populated.length < 2) return undefined;
  const oldest = populated[0];
  const newest = populated[populated.length - 1];
  return ((newest.ctl - oldest.ctl) / oldest.ctl) * 100;
}

// Training load for planning decisions. Intervals.icu recomputes *today's*
// wellness entry throughout the day as activities and planned loads sync, so its
// CTL/ATL/TSB jitter until the day settles — reading it can flip the fatigue
// tier (e.g. across tsb_fresh) on sync timing alone, not on any real change.
// Prefer the most recent *fully-settled* day (strictly before `today`) so the
// tier decision is stable across the sync window. Fall back to today's
// provisional entry only when no earlier day has populated data (new athlete or
// a sync gap), and to zeros when nothing is populated at all.
export function latestTrainingLoad(range: WellnessEntry[], today: string): TrainingLoad {
  const populated = range.filter((e) => e.ctl > 0).sort((a, b) => a.date.localeCompare(b.date));
  const settled = populated.filter((e) => e.date < today);
  const pick = settled[settled.length - 1] ?? populated[populated.length - 1];
  if (!pick) return { ctl: 0, atl: 0, tsb: 0 };
  return { ctl: pick.ctl, atl: pick.atl, tsb: pick.tsb };
}

export type Command = "plan" | "status" | "check";

interface ParsedArgs {
  command: Command;
  dryRun: boolean;
  json: boolean;
}

const VALID_COMMANDS: Command[] = ["plan", "status", "check"];

export function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) {
    throw new Error("No command provided. Usage: workout-planner <plan|status|check>");
  }

  const command = args[0] as Command;
  if (!VALID_COMMANDS.includes(command)) {
    throw new Error(`Unknown command: ${command}. Usage: workout-planner <plan|status|check>`);
  }

  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  return { command, dryRun, json };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

// One-line readiness summary for the status dashboard. "n/a" when there isn't
// enough HRV/RHR history to judge, so the line is never silently misleading.
export function formatReadiness(r: ReadinessSignal): string {
  if (r.status === "suppressed") {
    return `suppressed — ${r.reason} (planner downgrades the week one tier)`;
  }
  if (r.status === "normal") return "normal";
  return "n/a (insufficient HRV/resting-HR history)";
}

export function formatPlan(workouts: PlannedWorkout[]): string {
  const lines = workouts.map((w) => {
    const day = new Date(w.date + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "short",
    });
    const icon =
      w.type === "rest"
        ? "  "
        : w.type === "weights"
          ? "WT"
          : w.type === "sweet_spot"
            ? "SS"
            : "CY";
    const zoneTag = w.targetZone ? ` (${zoneLabel(w.targetZone)})` : "";
    const loadTag =
      typeof w.load === "number"
        ? `  ·  ${w.load} TSS${w.durationMin ? ` / ${w.durationMin}min` : ""}`
        : typeof w.durationMin === "number"
          ? `  ·  ${w.durationMin}min`
          : "";
    return `${w.date} (${day})  [${icon}]  ${w.name}  — ${w.intensity}${zoneTag}${loadTag}`;
  });
  return lines.join("\n");
}

// Sum of planned TSS across a week's workouts — shown under the plan so the
// weekly load budget is visible at a glance.
export function weeklyPlannedTss(workouts: PlannedWorkout[]): number {
  return workouts.reduce((sum, w) => sum + (w.load ?? 0), 0);
}

// Keyed by WorkoutType so adding a new variant is a compile error until the
// mapping is updated.
const WORKOUT_TYPE_TO_EVENT_TYPE: Record<WorkoutType, string> = {
  cycling: "Ride",
  sweet_spot: "Ride",
  weights: "WeightTraining",
  rest: "Note",
};

export function workoutToEvent(w: PlannedWorkout): IntervalsEvent {
  // When the workout has a deterministic structure, write it as an Intervals.icu
  // plain-text workout so the calendar shows target power (from FTP) / HR (from
  // stored HR zones); otherwise fall back to the prose description.
  const structured = structuredWorkoutFor(w);
  const event: IntervalsEvent = {
    // Intervals.icu's event API rejects a bare YYYY-MM-DD with a 422
    // ("could not be parsed at index 10") — it needs a time component.
    start_date_local: `${w.date}T00:00:00`,
    name: w.name,
    category: w.type === "rest" ? "NOTE" : "WORKOUT",
    type: WORKOUT_TYPE_TO_EVENT_TYPE[w.type],
    description: structured ? structured.text : w.description,
  };
  // Planned-load targets: shown on the calendar and folded into planned CTL/ATL.
  // A structured workout's step durations are the source of truth for its
  // duration; recompute moving_time (and TSS from IF) so the three stay
  // consistent with what the athlete will actually ride. For a single-effort
  // structured workout we use the IF the steps actually encode (rounded to the
  // whole percent written into the step), so the submitted TSS matches what
  // Intervals.icu re-computes from the step power rather than the raw plan IF.
  const durationMin = structured ? structured.minutes : w.durationMin;
  const effectiveIf = structured?.intensityFactor ?? w.intensityFactor;
  if (typeof durationMin === "number") event.moving_time = Math.round(durationMin * 60);
  if (structured && typeof durationMin === "number" && typeof effectiveIf === "number") {
    event.icu_training_load = Math.round((durationMin / 60) * effectiveIf ** 2 * 100);
  } else if (typeof w.load === "number") {
    event.icu_training_load = w.load;
  }
  if (typeof effectiveIf === "number") event.icu_intensity = effectiveIf;
  return event;
}

export interface PushResult {
  created: string[];
  failed: { date: string; name: string; error: string }[];
}

// Push every non-rest workout, recording outcomes instead of aborting on the
// first failure. Re-running re-creates a fully-failed day (it stays empty and
// gets re-planned). CAVEAT — stacked days: when the scheduler co-locates two
// sessions on one day (e.g. hard ride + weights) and one lands while the other
// fails, the created event now locks that day, so the failed session is NOT
// regenerated on re-run. It has to be re-added by hand (see push-week).
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

async function runCheck(intervals: IntervalsClient, xert: XertClient): Promise<number> {
  const today = todayLocal();
  let failures = 0;
  const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      console.log(`  ok    ${label}`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL  ${label} — ${msg}`);
    }
  };

  console.log("=== Pre-flight check ===");
  await step("Intervals.icu wellness fetch", () => intervals.getTrainingLoad(today));
  await step("Xert authenticate", () => xert.authenticate());
  await step("Xert training_info", () => xert.getTrainingInfo());
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { command, dryRun, json } = parseArgs(rawArgs);

  const intervalsKey = requireEnv("INTERVALS_API_KEY");
  const xertUser = requireEnv("XERT_USERNAME");
  const xertPass = requireEnv("XERT_PASSWORD");

  const intervals = new IntervalsClient(intervalsKey);
  const xert = new XertClient(xertUser, xertPass);

  if (command === "check") {
    const code = await runCheck(intervals, xert);
    process.exit(code);
  }

  const config = await loadConfig("config.yaml");

  if (command === "status") {
    await xert.authenticate();
    const today = todayLocal();
    const lookbackStr = addLocalDays(today, -28);
    const weekAgoStr = addLocalDays(today, -7);
    // Fetch the wider readiness window so status shows the same readiness state
    // the planner will act on; the ramp is still a trailing-7-day measure.
    const wellnessStr = addLocalDays(
      today,
      -(config.readiness.baseline_days + config.readiness.recent_days),
    );

    const [info, activities, wellnessRange, rideSettings] = await Promise.all([
      xert.getTrainingInfo(),
      intervals.getActivities(lookbackStr, today),
      intervals.getTrainingLoadRange(wellnessStr, today),
      intervals.getRideSportSettings(),
    ]);
    const ftp = rideSettings?.ftp ?? null;
    const eftp = latestEftp(activities);
    const load = latestTrainingLoad(wellnessRange, today);
    const distribution = computeDistribution(activities);
    const rampRatePct = computeWeeklyRampPct(wellnessRange.filter((e) => e.date >= weekAgoStr));
    const readiness = computeReadiness(wellnessRange, config);

    if (json) {
      const deficits = Object.fromEntries(
        ZONES.map((z) => [z, POLARIZED_TARGETS[z] - distribution[z]]),
      );
      const out = {
        training_load: load,
        icu_ftp: ftp,
        icu_eftp: eftp ?? null,
        readiness,
        xert: info,
        zones: { distribution, targets: POLARIZED_TARGETS, deficits },
        ramp: {
          weekly_pct: rampRatePct ?? null,
          threshold_pct: config.scheduling.max_weekly_ramp_pct,
          exceeds: rampGuardTriggered(rampRatePct, config),
        },
      };
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    console.log("=== Training Status ===");
    console.log(`CTL (Fitness):  ${load.ctl}`);
    console.log(`ATL (Fatigue):  ${load.atl}`);
    console.log(`TSB (Form):     ${load.tsb}`);
    console.log(`Readiness:      ${formatReadiness(readiness)}`);
    console.log();
    console.log(`FTP:    ${ftp !== null ? `${ftp}W` : "not set"}  (Intervals.icu)`);
    console.log(
      `eFTP:   ${eftp !== undefined ? `${Math.round(eftp)}W` : "n/a"}  (rolling estimate${config.ftp_sync.enabled ? "; plan auto-applies" : ""})`,
    );
    console.log(`LTP:    ${info.ltp}W`);
    console.log(`HIE:    ${info.hie} kJ`);
    console.log(`PP:     ${info.pp}W`);
    console.log(`Status: ${info.training_status}`);
    console.log(`Focus:  ${info.focus}`);
    return;
  }

  // plan command
  await xert.authenticate();
  const today = todayLocal();
  const endStr = addLocalDays(today, 6);
  const raceHorizonStr = addLocalDays(today, 364);
  const lookbackStr = addLocalDays(today, -28);
  const weekAgoStr = addLocalDays(today, -7);
  // The readiness baseline needs ~a month of wellness, well past the 7 days the
  // ramp uses. Fetch the wider window once and slice the ramp back to 7 days.
  const wellnessStr = addLocalDays(
    today,
    -(config.readiness.baseline_days + config.readiness.recent_days),
  );
  // Fetch events from just before the window too: a hard session yesterday
  // must block a hard placement today (back-to-back) and a strength session
  // within min_weight_gap_days must push this week's first one out. The
  // scheduler gives pre-window events a negative day index — they constrain
  // spacing without locking any window day or consuming weekly quotas.
  const eventLookbackStr = addLocalDays(
    today,
    -Math.max(1, config.scheduling.min_weight_gap_days - 1),
  );

  const [events, info, activities, wellnessRange, raceEvents, rideSettings] = await Promise.all([
    intervals.getEvents(eventLookbackStr, endStr),
    xert.getTrainingInfo(),
    intervals.getActivities(lookbackStr, today),
    intervals.getTrainingLoadRange(wellnessStr, today),
    intervals.getEvents(today, raceHorizonStr),
    intervals.getRideSportSettings(),
  ]);
  const load = latestTrainingLoad(wellnessRange, today);

  // eFTP sync before planning: the applied FTP is what Intervals.icu will
  // resolve this week's `% FTP` steps against, and what prose watt/HR
  // placeholders render with. Dry runs preview the update without writing.
  const renderValues = await syncFtp(intervals, rideSettings, activities, config.ftp_sync, {
    dryRun,
  });

  const zoneDistribution = computeDistribution(activities);
  // Ramp is a trailing-7-day measure, so slice the wider readiness window back
  // down — computeWeeklyRampPct compares the range's endpoints.
  const rampRatePct = computeWeeklyRampPct(wellnessRange.filter((e) => e.date >= weekAgoStr));
  const readiness = computeReadiness(wellnessRange, config);
  // Activities already logged inside the planning window (typically today) lock
  // their day so the planner doesn't schedule on top of a completed session.
  const completedDates = [
    ...new Set(
      activities
        .map((a) => a.start_date_local.slice(0, 10))
        .filter((d) => d >= today && d <= endStr),
    ),
  ];

  const raceDate = resolveRaceDate(raceEvents, today, config.periodization.race_date);
  const weeksToRace = raceDate ? weeksUntil(today, raceDate) : undefined;

  const planned = schedule({
    startDate: today,
    existingEvents: events,
    trainingLoad: load,
    xertInfo: info,
    config,
    zoneDistribution,
    rampRatePct,
    completedDates,
    weeksToRace,
    readiness,
  }).map((w) => ({ ...w, description: renderTargets(w.description, renderValues) }));

  // Match the scheduler: suppressed readiness downgrades the displayed tier too,
  // so the status line never contradicts the plan it printed.
  const fatigue = effectiveFatigue(classifyFatigue(load.tsb, config), readiness);
  const fatigueLabel: Record<string, string> = {
    fresh: "fresh — scheduling hard rides",
    moderate: "moderate — mixed intensity",
    fatigued: "fatigued — cycling kept easy",
    very_fatigued: "very fatigued — dropped sweet-spot, reduced weights",
  };

  console.log("=== Weekly Plan ===");
  console.log(
    `TSB ${load.tsb.toFixed(1)} (${fatigueLabel[fatigue] ?? fatigue}) — Xert: ${info.training_status || "n/a"}`,
  );
  if (readiness.status === "suppressed") {
    console.log(`READINESS: ${readiness.reason} — week downgraded one fatigue tier`);
  }
  if (rampGuardTriggered(rampRatePct, config) && rampRatePct !== undefined) {
    console.log(
      `WARNING: CTL ramp +${rampRatePct.toFixed(1)}%/wk > ${config.scheduling.max_weekly_ramp_pct}% threshold — hard rides downgraded`,
    );
  }
  console.log();
  console.log(formatPlan(planned));
  console.log(`\nWeekly planned load: ${weeklyPlannedTss(planned)} TSS`);
  console.log();

  if (dryRun) {
    console.log("(dry run — nothing pushed to Intervals.icu)");
    return;
  }

  console.log("Pushing to Intervals.icu...");
  const { created, failed } = await pushPlan(intervals, planned);
  if (failed.length === 0) {
    console.log(`Done. Created ${created.length} event(s).`);
  } else {
    console.log(
      `Created ${created.length}, failed ${failed.length}. ` +
        `Re-run to retry fully-failed days. A failed session on a day that ` +
        `partially landed won't regenerate — re-add it by hand (see push-week).`,
    );
    process.exitCode = 1;
  }
}

// Only run main when executed directly (not when imported by tests)
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("/cli.js") || process.argv[1].endsWith("/cli.ts"));

if (isMain) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
