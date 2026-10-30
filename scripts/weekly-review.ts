// One-off training-volume review: pulls recent activities + wellness from
// Intervals.icu and summarizes weekly volume, intensity mix, and CTL ramp.
// Usage: npx tsx scripts/weekly-review.ts [weeks]   (default 8)
import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });
import { addLocalDays, todayLocal } from "../src/dates.js";
import { IntervalsClient } from "../src/intervals.js";
import { formatWeeklyReview, summarizeWeeks } from "../src/weeklyReview.js";

async function main(): Promise<void> {
  const weeksBack = Number(process.argv[2] ?? 8);
  if (!Number.isInteger(weeksBack) || weeksBack <= 0) {
    throw new Error(`weeks must be a positive whole number, got "${process.argv[2]}"`);
  }
  const apiKey = process.env.INTERVALS_API_KEY;
  if (!apiKey) throw new Error("INTERVALS_API_KEY not set");

  const today = todayLocal();
  const start = addLocalDays(today, -weeksBack * 7 - 7); // pad a week for ramp context

  const client = new IntervalsClient(apiKey);
  const [activities, wellness] = await Promise.all([
    client.getActivities(start, today),
    client.getTrainingLoadRange(start, today),
  ]);
  console.log(formatWeeklyReview(summarizeWeeks(activities), wellness, weeksBack));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
