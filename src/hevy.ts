// Hevy → Intervals.icu strength sync: the logic behind
// scripts/push-strength-hevy.ts, which only parses flags and wires up keys.
//
// The Intervals.icu activity is normally created by the Companion Apple Health
// sync; this fills in the lift detail that Intervals.icu has no structured
// fields for. Hevy workouts are matched to WeightTraining activities by UTC
// start time (timezone-proof). With `createMissing`, a workout that matches
// nothing (never recorded on the watch) is created as a manual activity.
import type { IntervalsClient } from "./intervals.js";
import {
  MARKER,
  KG_TO_LB,
  buildDescription,
  type StrengthExercise,
  type StrengthSet,
} from "./strength.js";
import type { Activity } from "./types.js";

const HEVY_BASE = "https://api.hevyapp.com/v1";
export const PAGE_SIZE = 10; // Hevy max
const TIMEOUT_MS = 30_000;

type FetchFn = typeof globalThis.fetch;

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

export interface HevyPage {
  pageCount: number;
  workouts: HevyWorkout[];
}

// The endpoint returns { page, page_count, workouts: [...] }; tolerate a bare
// array too (pageCount Infinity defers to the short-page break in
// fetchHevyWorkouts).
export function parseHevyPage(data: unknown): HevyPage {
  if (Array.isArray(data)) return { pageCount: Infinity, workouts: data as HevyWorkout[] };
  const body = data as { page_count?: unknown; workouts?: unknown };
  return {
    pageCount: typeof body.page_count === "number" ? body.page_count : Infinity,
    workouts: Array.isArray(body.workouts) ? (body.workouts as HevyWorkout[]) : [],
  };
}

export async function fetchHevyPage(
  page: number,
  apiKey: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<HevyPage> {
  const url = `${HEVY_BASE}/workouts?page=${page}&pageSize=${PAGE_SIZE}`;
  const res = await fetchFn(url, {
    headers: { "api-key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Hevy 404s any page past page_count rather than returning an empty list.
  if (res.status === 404) return { pageCount: page - 1, workouts: [] };
  if (!res.ok) {
    throw new Error(`Hevy API error (${res.status}): ${await res.text()}`);
  }
  return parseHevyPage((await res.json()) as unknown);
}

// Up to `pages` pages, newest first, stopping early at the last page.
export async function fetchHevyWorkouts(
  apiKey: string,
  pages: number,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<HevyWorkout[]> {
  const workouts: HevyWorkout[] = [];
  for (let p = 1; p <= pages; p++) {
    const { pageCount, workouts: batch } = await fetchHevyPage(p, apiKey, fetchFn);
    workouts.push(...batch);
    if (p >= pageCount || batch.length < PAGE_SIZE) break;
  }
  return workouts;
}

// --- Normalize a Hevy workout into StrengthExercise[] (kg → lb) ---
export function toExercises(w: HevyWorkout, includeWarmups: boolean): StrengthExercise[] {
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

// Closest WeightTraining activity by UTC start within the tolerance, or null.
export function matchActivity(
  activities: Pick<Activity, "id" | "start_date">[],
  startTimeUtc: string,
  toleranceMs: number,
): string | null {
  const target = Date.parse(startTimeUtc);
  let best: { id: string; diff: number } | null = null;
  for (const a of activities) {
    const diff = Math.abs(Date.parse(a.start_date) - target);
    if (diff <= toleranceMs && (!best || diff < best.diff)) best = { id: a.id, diff };
  }
  return best?.id ?? null;
}

export type HevyClient = Pick<
  IntervalsClient,
  "getActivities" | "getActivityDescription" | "updateActivity" | "createManualActivity"
>;

export interface HevySyncOptions {
  apply: boolean;
  force: boolean;
  includeWarmups: boolean;
  createMissing: boolean;
  toleranceMin: number;
  log?: (msg: string) => void;
}

export interface HevySyncResult {
  matched: number;
  unmatched: number;
  created: number;
  skipped: number;
  written: number;
}

// Write each workout's lift detail into its matching activity (or create one).
// Without `apply` nothing is written, but descriptions are still read so the
// dry run reports exactly what an apply run would skip.
export async function syncHevyWorkouts(
  client: HevyClient,
  workouts: HevyWorkout[],
  opts: HevySyncOptions,
): Promise<HevySyncResult> {
  const { apply, force, includeWarmups, createMissing, toleranceMin } = opts;
  const log = opts.log ?? console.log;
  const result: HevySyncResult = { matched: 0, unmatched: 0, created: 0, skipped: 0, written: 0 };
  if (workouts.length === 0) return result;

  // Activity date range: pad ±1 day so UTC/local day shifts can't drop a match.
  const epochs = workouts.map((w) => Date.parse(w.start_time));
  const dayMs = 86_400_000;
  const oldest = new Date(Math.min(...epochs) - dayMs).toISOString().slice(0, 10);
  const newest = new Date(Math.max(...epochs) + dayMs).toISOString().slice(0, 10);

  const activities = (await client.getActivities(oldest, newest)).filter(
    (a) => a.type === "WeightTraining" && a.start_date,
  );
  const toleranceMs = toleranceMin * 60_000;

  log(
    `${apply ? "APPLYING" : "DRY RUN"} — ${workouts.length} Hevy workout(s), ` +
      `${oldest}..${newest}, ±${toleranceMin}min match${force ? ", force overwrite" : ""}` +
      `${createMissing ? ", create missing" : ""}\n`,
  );

  // Oldest-first output for readability.
  for (const w of [...workouts].sort((a, b) => a.start_time.localeCompare(b.start_time))) {
    const local = w.start_time
      .replace("T", " ")
      .replace(/:\d\dZ?$/, "")
      .replace("Z", "");
    const description = buildDescription(toExercises(w, includeWarmups));
    const exerciseCount = description.split("\n").length - 1;
    const id = matchActivity(activities, w.start_time, toleranceMs);

    if (!id) {
      if (!createMissing) {
        result.unmatched++;
        log(`✗ ${local}Z  "${w.title}"  no WeightTraining activity within ±${toleranceMin}min`);
        continue;
      }
      // No Companion-synced activity to decorate (the session was never
      // recorded on the watch) — create a manual WeightTraining activity from
      // the Hevy times instead. Re-runs stay idempotent: the created activity
      // matches by start time next run and MARKER owns its description.
      result.created++;
      const activity = manualActivityFor(w, description);
      log(
        `+ ${local}Z  no matching activity — creating manual WeightTraining (${exerciseCount} exercises)`,
      );
      if (!("moving_time" in activity)) {
        log(`      (no usable end_time in Hevy — created without a duration)`);
      }
      for (const line of description.split("\n").slice(1)) log(`      ${line}`);
      if (apply) {
        await client.createManualActivity(activity);
      }
      continue;
    }
    result.matched++;

    // Always fetch the description — even in dry run — so the ✓/⊘ shown here
    // matches what apply would actually do (otherwise dry run never reports
    // the "non-Strong description, skipped" case).
    const existing = await client.getActivityDescription(id);
    const ours = existing.startsWith(MARKER);
    if (existing.trim() && !ours && !force) {
      result.skipped++;
      log(`⊘ ${local}Z  ${id}  has a non-Strong description — skipped (use --force)`);
      continue;
    }

    log(`✓ ${local}Z  ${id}  (${exerciseCount} exercises)`);
    for (const line of description.split("\n").slice(1)) log(`      ${line}`);

    if (apply) {
      await client.updateActivity(id, { description });
      result.written++;
    }
  }

  const { matched, unmatched, created, skipped, written } = result;
  log(
    `\n${matched} matched, ${unmatched} unmatched, ${created} created, ${skipped} skipped` +
      (apply ? `, ${written} description(s) written.` : `. Re-run with --apply to write.`),
  );
  return result;
}
