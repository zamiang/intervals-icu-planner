// Push Strong strength-log detail (exercises, sets, reps, weights, bands) into
// the description of the matching Intervals.icu WeightTraining activity.
//
// Background: the Intervals.icu Companion Apple Health sync creates a
// WeightTraining activity for each Strong session, but Intervals.icu has no
// structured fields for per-set reps/weight — the recommended place for lift
// detail is the activity description (free text). This script reads a Strong
// CSV export and writes a readable summary there, matched by exact start time.
//
//   npm run push-strength                       # dry run (default), all workouts
//   npm run push-strength -- --apply            # actually write descriptions
//   npm run push-strength -- --apply --force    # overwrite non-empty descriptions
//   npm run push-strength -- 2026-06-10         # only that day's workouts
//   npm run push-strength -- --file path.csv    # custom CSV path
//
// Idempotent: written descriptions start with MARKER. Without --force, an
// activity whose description is non-empty and not ours is left untouched.
import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });
import { promises as fs } from "node:fs";
import { IntervalsClient } from "../src/intervals.js";
import {
  MARKER,
  buildDescription,
  type StrengthExercise,
  type StrengthSet,
} from "../src/strength.js";

const DEFAULT_CSV = "strength-workout/strong_workouts.csv";

const rawArgs = process.argv.slice(2);
const apply = rawArgs.includes("--apply");
const force = rawArgs.includes("--force");
const fileIdx = rawArgs.indexOf("--file");
if (fileIdx >= 0 && !rawArgs[fileIdx + 1]) {
  console.error("--file requires a path argument, e.g. --file path/to/export.csv");
  process.exit(1);
}
const csvPath = fileIdx >= 0 ? rawArgs[fileIdx + 1] : DEFAULT_CSV;
const dayFilter = rawArgs.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;

// --- CSV parsing (handles quoted fields with embedded commas/quotes) ---
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => (obj[h] = r[idx] ?? ""));
    return obj;
  });
}

// --- Normalize one Strong workout's rows into StrengthExercise[] ---
function num(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// The Strong "Weight" column is already in the user's display unit (lb here);
// for band lifts it records band resistance. Rest Timer rows are skipped.
function toExercises(rows: Record<string, string>[]): StrengthExercise[] {
  const order: string[] = [];
  const byExercise = new Map<string, StrengthSet[]>();
  for (const r of rows) {
    if (r["Set Order"] === "Rest Timer") continue;
    const name = r["Exercise Name"];
    if (!byExercise.has(name)) {
      byExercise.set(name, []);
      order.push(name);
    }
    byExercise.get(name)!.push({
      weightLb: num(r["Weight"]),
      reps: num(r["Reps"]),
      seconds: num(r["Seconds"]),
      rpe: r["RPE"]?.trim() ?? "",
      note: r["Notes"]?.trim() ?? "",
    });
  }
  return order.map((name) => ({ name, sets: byExercise.get(name)! }));
}

// --- Main ---
const text = await fs.readFile(csvPath, "utf8");
const allRows = parseCsv(text);

// Group rows by workout instance (its start timestamp).
const byWorkout = new Map<string, Record<string, string>[]>();
for (const r of allRows) {
  const date = r["Date"]; // "2026-06-10 07:58:26"
  if (!date) continue;
  if (dayFilter && !date.startsWith(dayFilter)) continue;
  if (!byWorkout.has(date)) byWorkout.set(date, []);
  byWorkout.get(date)!.push(r);
}

const workoutDates = [...byWorkout.keys()].sort();
if (workoutDates.length === 0) {
  console.log(`No Strong workouts found${dayFilter ? ` for ${dayFilter}` : ""} in ${csvPath}.`);
  process.exit(0);
}

const oldest = workoutDates[0].slice(0, 10);
const newest = workoutDates[workoutDates.length - 1].slice(0, 10);

const intervalsKey = process.env.INTERVALS_API_KEY;
if (!intervalsKey) {
  console.error("Missing INTERVALS_API_KEY in .env (Intervals.icu → Settings → API).");
  process.exit(1);
}
const client = new IntervalsClient(intervalsKey);
const activities = await client.getActivities(oldest, newest);

// Index WeightTraining activities by exact start timestamp, plus a same-day
// fallback bucket.
const byStart = new Map<string, string>(); // "2026-06-10T07:58:26" -> id
const byDay = new Map<string, string[]>();
for (const a of activities) {
  if (a.type !== "WeightTraining") continue;
  const start = a.start_date_local; // "2026-06-10T07:58:26"
  byStart.set(start, a.id);
  const day = start.slice(0, 10);
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day)!.push(a.id);
}

console.log(
  `${apply ? "APPLYING" : "DRY RUN"} — ${workoutDates.length} Strong workout(s), ` +
    `${oldest}..${newest}${force ? " (force overwrite)" : ""}\n`,
);

let matched = 0;
let written = 0;
let skipped = 0;
let unmatched = 0;

for (const date of workoutDates) {
  const rows = byWorkout.get(date)!;
  const key = date.replace(" ", "T");
  const day = date.slice(0, 10);
  let id = byStart.get(key);
  let matchNote = "exact start";
  if (!id) {
    const sameDay = byDay.get(day) ?? [];
    if (sameDay.length === 1) {
      id = sameDay[0];
      matchNote = "same-day";
    }
  }

  const description = buildDescription(toExercises(rows));
  const exerciseCount = description.split("\n").length - 1;

  if (!id) {
    unmatched++;
    console.log(`✗ ${date}  no WeightTraining activity (${exerciseCount} exercises) — skipped`);
    continue;
  }
  matched++;

  // Always fetch the description — even in dry run — so the ✓/⊘ shown here
  // matches what --apply would actually do (otherwise dry run never reports
  // the "non-Strong description, skipped" case).
  const existing = await client.getActivityDescription(id);
  const ours = existing.startsWith(MARKER);
  if (existing.trim() && !ours && !force) {
    skipped++;
    console.log(`⊘ ${date}  ${id}  has a non-Strong description — skipped (use --force)`);
    continue;
  }

  console.log(`✓ ${date}  ${id}  (${matchNote}, ${exerciseCount} exercises)`);
  for (const line of description.split("\n").slice(1)) console.log(`      ${line}`);

  if (apply) {
    await client.updateActivity(id, { description });
    written++;
  }
}

console.log(
  `\n${matched} matched, ${unmatched} unmatched, ${skipped} skipped` +
    (apply ? `, ${written} written.` : `. Re-run with --apply to write.`),
);
