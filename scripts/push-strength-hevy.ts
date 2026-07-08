// Push Hevy strength-log detail (exercises, sets, reps, weights, bands, RPE)
// into the description of the matching Intervals.icu WeightTraining activity —
// the API-driven version of push-strength.ts (which reads a Strong CSV).
//
// The Intervals.icu activity is normally created by the Companion Apple Health
// sync; this script fills in the lift detail that Intervals.icu has no
// structured fields for. Workouts are pulled live from the Hevy API and
// matched to activities by UTC start time (timezone-proof), so there's no
// manual export step. With --create-missing, a workout that matches nothing
// (never recorded on the watch) is created as a manual activity instead.
//
// Requires HEVY_API_KEY in .env (Hevy Pro → Settings → Developer → API key).
//
//   npm run push-strength:hevy                    # dry run, 10 most recent Hevy workouts
//   npm run push-strength:hevy -- --apply         # write descriptions
//   npm run push-strength:hevy -- --pages 3       # fetch 3 pages (30 workouts)
//   npm run push-strength:hevy -- --since 2026-06-01
//   npm run push-strength:hevy -- --apply --force # overwrite non-Strong descriptions
//   npm run push-strength:hevy -- --include-warmups
//   npm run push-strength:hevy -- --tolerance 15  # match window in minutes (default 10)
//   npm run push-strength:hevy -- --apply --create-missing  # create the activity when unmatched
import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });
import { IntervalsClient } from "../src/intervals.js";
import {
  MARKER,
  KG_TO_LB,
  buildDescription,
  type StrengthExercise,
  type StrengthSet,
} from "../src/strength.js";

const HEVY_BASE = "https://api.hevyapp.com/v1";
const PAGE_SIZE = 10; // Hevy max

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const force = args.includes("--force");
const includeWarmups = args.includes("--include-warmups");
const createMissing = args.includes("--create-missing");
function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function numericFlag(name: string, fallback: number): number {
  const raw = flagValue(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`${name} expects a number, got "${raw}".`);
    process.exit(1);
  }
  return n;
}
const pages = Math.max(1, numericFlag("--pages", 1));
const since = flagValue("--since") ?? null; // YYYY-MM-DD; skip workouts before this
const toleranceMin = numericFlag("--tolerance", 10);

// --- Hevy types (subset of the API we use) ---
interface HevySet {
  type: string; // normal | warmup | dropset | failure
  weight_kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  rpe: number | null;
}
interface HevyExercise {
  title: string;
  notes?: string | null;
  sets: HevySet[];
}
export interface HevyWorkout {
  id: string;
  title: string;
  start_time: string; // UTC ISO, "...Z"
  end_time?: string; // UTC ISO; not trusted — may be absent or malformed
  exercises: HevyExercise[];
}

// Intervals.icu's manual-activity endpoint wants start_date_local; Hevy
// reports UTC. Render in the host timezone (the weekly workflow pins TZ) —
// the same local time the Companion app would have stamped on this session.
export function toLocalDateTime(utcIso: string): string {
  const d = new Date(utcIso);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// Payload for createManualActivity from a Hevy workout that matched no
// existing WeightTraining activity. Hevy's `title` is the routine name and
// often stale ("1h Cycling Workout"), so the activity gets a plain name;
// external_id ties it back to the Hevy workout. moving_time is omitted when
// end_time is missing or nonsensical (Hevy responses aren't schema-validated)
// rather than writing a garbage duration.
export function manualActivityFor(
  w: Pick<HevyWorkout, "id" | "start_time" | "end_time">,
  description: string,
): Record<string, unknown> {
  const start = Date.parse(w.start_time);
  const end = typeof w.end_time === "string" ? Date.parse(w.end_time) : NaN;
  const durationSecs = Math.round((end - start) / 1000);
  return {
    start_date_local: toLocalDateTime(w.start_time),
    type: "WeightTraining",
    name: "Strength Training",
    ...(Number.isFinite(durationSecs) && durationSecs > 0 ? { moving_time: durationSecs } : {}),
    description,
    external_id: `hevy-${w.id}`,
  };
}

async function fetchHevyPage(page: number, apiKey: string): Promise<HevyWorkout[]> {
  const url = `${HEVY_BASE}/workouts?page=${page}&pageSize=${PAGE_SIZE}`;
  const res = await fetch(url, { headers: { "api-key": apiKey, Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Hevy API error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as unknown;
  // The endpoint returns { page, page_count, workouts: [...] }; tolerate a bare array too.
  if (Array.isArray(data)) return data as HevyWorkout[];
  const workouts = (data as { workouts?: unknown }).workouts;
  return Array.isArray(workouts) ? (workouts as HevyWorkout[]) : [];
}

// --- Normalize a Hevy workout into StrengthExercise[] (kg → lb) ---
function toExercises(w: HevyWorkout): StrengthExercise[] {
  return w.exercises.map((ex) => {
    const sets: StrengthSet[] = ex.sets
      .filter((s) => includeWarmups || s.type !== "warmup")
      .map((s) => ({
        weightLb: s.weight_kg ? s.weight_kg * KG_TO_LB : 0,
        reps: s.reps ?? 0,
        seconds: s.duration_seconds ?? 0,
        rpe: s.rpe != null ? String(s.rpe) : "",
        // Exercise-level note in Hevy; attach to each set so the shared
        // formatter dedupes it to one "(note)" on the exercise line.
        note: ex.notes?.trim() ?? "",
      }));
    return { name: ex.title, sets };
  });
}

async function main(): Promise<void> {
  const apiKey = process.env.HEVY_API_KEY;
  if (!apiKey) {
    console.error("Missing HEVY_API_KEY in .env (Hevy Pro → Settings → Developer → API key).");
    process.exit(1);
  }

  // Fetch workouts (newest first), applying --since and --pages limits.
  const workouts: HevyWorkout[] = [];
  for (let p = 1; p <= pages; p++) {
    const batch = await fetchHevyPage(p, apiKey);
    if (batch.length === 0) break;
    workouts.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  const selected = workouts.filter((w) => !since || w.start_time.slice(0, 10) >= since);

  if (selected.length === 0) {
    console.log(`No Hevy workouts${since ? ` since ${since}` : ""} in ${pages} page(s).`);
    return;
  }

  // Activity date range: pad ±1 day so UTC/local day shifts can't drop a match.
  const epochs = selected.map((w) => Date.parse(w.start_time));
  const dayMs = 86_400_000;
  const oldest = new Date(Math.min(...epochs) - dayMs).toISOString().slice(0, 10);
  const newest = new Date(Math.max(...epochs) + dayMs).toISOString().slice(0, 10);

  const intervalsKey = process.env.INTERVALS_API_KEY;
  if (!intervalsKey) {
    console.error("Missing INTERVALS_API_KEY in .env (Intervals.icu → Settings → API).");
    process.exit(1);
  }
  const client = new IntervalsClient(intervalsKey);
  const activities = (await client.getActivities(oldest, newest)).filter(
    (a) => a.type === "WeightTraining" && a.start_date,
  );

  // Match by closest UTC start within the tolerance window.
  const toleranceMs = toleranceMin * 60_000;
  function matchActivity(startTimeUtc: string): string | null {
    const target = Date.parse(startTimeUtc);
    let best: { id: string; diff: number } | null = null;
    for (const a of activities) {
      const diff = Math.abs(Date.parse(a.start_date) - target);
      if (diff <= toleranceMs && (!best || diff < best.diff)) best = { id: a.id, diff };
    }
    return best?.id ?? null;
  }

  console.log(
    `${apply ? "APPLYING" : "DRY RUN"} — ${selected.length} Hevy workout(s), ` +
      `${oldest}..${newest}, ±${toleranceMin}min match${force ? ", force overwrite" : ""}` +
      `${createMissing ? ", create missing" : ""}\n`,
  );

  let matched = 0;
  let written = 0;
  let skipped = 0;
  let unmatched = 0;
  let created = 0;

  // Oldest-first output for readability.
  for (const w of [...selected].sort((a, b) => a.start_time.localeCompare(b.start_time))) {
    const local = w.start_time
      .replace("T", " ")
      .replace(/:\d\dZ?$/, "")
      .replace("Z", "");
    const description = buildDescription(toExercises(w));
    const exerciseCount = description.split("\n").length - 1;
    const id = matchActivity(w.start_time);

    if (!id) {
      if (!createMissing) {
        unmatched++;
        console.log(
          `✗ ${local}Z  "${w.title}"  no WeightTraining activity within ±${toleranceMin}min`,
        );
        continue;
      }
      // No Companion-synced activity to decorate (the session was never
      // recorded on the watch) — create a manual WeightTraining activity from
      // the Hevy times instead. Re-runs stay idempotent: the created activity
      // matches by start time next run and MARKER owns its description.
      created++;
      const activity = manualActivityFor(w, description);
      console.log(
        `+ ${local}Z  no matching activity — creating manual WeightTraining (${exerciseCount} exercises)`,
      );
      if (!("moving_time" in activity)) {
        console.log(`      (no usable end_time in Hevy — created without a duration)`);
      }
      for (const line of description.split("\n").slice(1)) console.log(`      ${line}`);
      if (apply) {
        await client.createManualActivity(activity);
      }
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
      console.log(`⊘ ${local}Z  ${id}  has a non-Strong description — skipped (use --force)`);
      continue;
    }

    console.log(`✓ ${local}Z  ${id}  (${exerciseCount} exercises)`);
    for (const line of description.split("\n").slice(1)) console.log(`      ${line}`);

    if (apply) {
      await client.updateActivity(id, { description });
      written++;
    }
  }

  console.log(
    `\n${matched} matched, ${unmatched} unmatched, ${created} created, ${skipped} skipped` +
      (apply ? `, ${written} description(s) written.` : `. Re-run with --apply to write.`),
  );
}

// Only run main when executed directly (not when imported by tests)
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("push-strength-hevy.ts") ||
    process.argv[1].endsWith("push-strength-hevy.js"));

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
