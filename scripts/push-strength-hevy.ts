// Push Hevy strength-log detail (exercises, sets, reps, weights, bands, RPE)
// into the description of the matching Intervals.icu WeightTraining activity —
// the API-driven version of push-strength.ts (which reads a Strong CSV).
// Flag parsing only; the fetch/match/write logic lives in src/hevy.ts.
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
import { fetchHevyWorkouts, syncHevyWorkouts } from "../src/hevy.js";

const args = process.argv.slice(2);
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

async function main(): Promise<void> {
  const pages = Math.max(1, numericFlag("--pages", 1));
  const since = flagValue("--since") ?? null; // YYYY-MM-DD; skip workouts before this

  const apiKey = process.env.HEVY_API_KEY;
  if (!apiKey) {
    console.error("Missing HEVY_API_KEY in .env (Hevy Pro → Settings → Developer → API key).");
    process.exit(1);
  }

  const workouts = await fetchHevyWorkouts(apiKey, pages);
  const selected = workouts.filter((w) => !since || w.start_time.slice(0, 10) >= since);
  if (selected.length === 0) {
    console.log(`No Hevy workouts${since ? ` since ${since}` : ""} in ${pages} page(s).`);
    return;
  }

  const intervalsKey = process.env.INTERVALS_API_KEY;
  if (!intervalsKey) {
    console.error("Missing INTERVALS_API_KEY in .env (Intervals.icu → Settings → API).");
    process.exit(1);
  }

  await syncHevyWorkouts(new IntervalsClient(intervalsKey), selected, {
    apply: args.includes("--apply"),
    force: args.includes("--force"),
    includeWarmups: args.includes("--include-warmups"),
    createMissing: args.includes("--create-missing"),
    toleranceMin: numericFlag("--tolerance", 10),
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
