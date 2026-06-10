import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });
import { loadConfig } from "./config.js";
import { IntervalsClient } from "./intervals.js";
import { XertClient } from "./xert.js";
import { schedule, classifyFatigue, rampGuardTriggered } from "./scheduler.js";
import { computeDistribution, POLARIZED_TARGETS, ZONES, zoneLabel } from "./zones.js";
import type { PlannedWorkout, IntervalsEvent, WellnessEntry, WorkoutType } from "./types.js";

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

// CTL ramp = (today - 7d ago) / (7d ago) * 100. Returns undefined when the
// 7-day-ago wellness entry is missing or zero (new athlete, gap in syncing).
export function computeWeeklyRampPct(range: WellnessEntry[]): number | undefined {
  if (range.length === 0) return undefined;
  const sorted = [...range].sort((a, b) => a.date.localeCompare(b.date));
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  if (oldest.ctl <= 0) return undefined;
  return ((newest.ctl - oldest.ctl) / oldest.ctl) * 100;
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
  const event: IntervalsEvent = {
    // Intervals.icu's event API rejects a bare YYYY-MM-DD with a 422
    // ("could not be parsed at index 10") — it needs a time component.
    start_date_local: `${w.date}T00:00:00`,
    name: w.name,
    category: w.type === "rest" ? "NOTE" : "WORKOUT",
    type: WORKOUT_TYPE_TO_EVENT_TYPE[w.type],
    description: w.description,
  };
  // Planned-load targets: shown on the calendar and folded into planned CTL/ATL.
  if (typeof w.load === "number") event.icu_training_load = w.load;
  if (typeof w.durationMin === "number") event.moving_time = Math.round(w.durationMin * 60);
  if (typeof w.intensityFactor === "number") event.icu_intensity = w.intensityFactor;
  return event;
}

async function runCheck(intervals: IntervalsClient, xert: XertClient): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
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
    const today = new Date().toISOString().slice(0, 10);
    const lookbackStart = new Date();
    lookbackStart.setDate(lookbackStart.getDate() - 28);
    const lookbackStr = lookbackStart.toISOString().slice(0, 10);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().slice(0, 10);

    const [load, info, activities, wellnessRange] = await Promise.all([
      intervals.getTrainingLoad(today),
      xert.getTrainingInfo(),
      intervals.getActivities(lookbackStr, today),
      intervals.getTrainingLoadRange(weekAgoStr, today),
    ]);
    const distribution = computeDistribution(activities);
    const rampRatePct = computeWeeklyRampPct(wellnessRange);

    if (json) {
      const deficits = Object.fromEntries(
        ZONES.map((z) => [z, POLARIZED_TARGETS[z] - distribution[z]]),
      );
      const out = {
        training_load: load,
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
    console.log();
    console.log(`FTP:    ${info.ftp}W`);
    console.log(`LTP:    ${info.ltp}W`);
    console.log(`HIE:    ${info.hie} kJ`);
    console.log(`PP:     ${info.pp}W`);
    console.log(`Status: ${info.training_status}`);
    console.log(`Focus:  ${info.focus}`);
    return;
  }

  // plan command
  await xert.authenticate();
  const today = new Date().toISOString().slice(0, 10);
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 6);
  const endStr = endDate.toISOString().slice(0, 10);
  const raceHorizon = new Date();
  raceHorizon.setDate(raceHorizon.getDate() + 364);
  const raceHorizonStr = raceHorizon.toISOString().slice(0, 10);
  const lookbackStart = new Date();
  lookbackStart.setDate(lookbackStart.getDate() - 28);
  const lookbackStr = lookbackStart.toISOString().slice(0, 10);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);

  const [events, load, info, activities, wellnessRange, raceEvents] = await Promise.all([
    intervals.getEvents(today, endStr),
    intervals.getTrainingLoad(today),
    xert.getTrainingInfo(),
    intervals.getActivities(lookbackStr, today),
    intervals.getTrainingLoadRange(weekAgoStr, today),
    intervals.getEvents(today, raceHorizonStr),
  ]);

  const zoneDistribution = computeDistribution(activities);
  const rampRatePct = computeWeeklyRampPct(wellnessRange);
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
  });

  const fatigue = classifyFatigue(load.tsb, config);
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
  for (const w of planned) {
    if (w.type === "rest") continue; // don't push rest days
    const event = workoutToEvent(w);
    await intervals.createEvent(event);
    console.log(`  Created: ${w.date} — ${w.name}`);
  }
  console.log("Done.");
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
