// Weekly training-volume review: the logic behind scripts/weekly-review.ts.
// Summarizes volume, intensity mix, and CTL ramp per Monday-anchored week.
import { addLocalDays, toLocalISODate } from "./dates.js";
import type { Activity, WellnessEntry } from "./types.js";

export interface WeekSummary {
  tss: number;
  hours: number;
  rides: number;
  weights: number;
  z12s: number; // seconds in Z1+Z2 (easy)
  hards: number; // seconds in Z3+ (moderate/hard)
  longRide: number; // longest single ride, hours
  byType: Record<string, number>;
}

// Monday of the week holding this date, or null for a missing/invalid date.
export function weekKey(dateStr: string): string | null {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return toLocalISODate(d);
}

export function summarizeWeeks(activities: Activity[]): Map<string, WeekSummary> {
  const weeks = new Map<string, WeekSummary>();
  for (const a of activities) {
    const k = weekKey(a.start_date_local || a.start_date);
    if (!k) continue;
    let w = weeks.get(k);
    if (!w) {
      w = { tss: 0, hours: 0, rides: 0, weights: 0, z12s: 0, hards: 0, longRide: 0, byType: {} };
      weeks.set(k, w);
    }
    const hours = (a.moving_time ?? 0) / 3600;
    const type = a.type || "Other";
    w.tss += a.icu_training_load;
    w.hours += hours;
    w.byType[type] = (w.byType[type] ?? 0) + a.icu_training_load;
    if (/ride/i.test(type)) {
      w.rides++;
      w.longRide = Math.max(w.longRide, hours);
    }
    if (/weight/i.test(type)) w.weights++;
    if (a.icu_zone_times) {
      const [z1, z2, ...rest] = a.icu_zone_times;
      w.z12s += z1 + z2;
      w.hards += rest.reduce((sum, secs) => sum + secs, 0);
    }
  }
  return weeks;
}

// CTL on the last populated day of the week. Today's entry can read zero before
// activities sync (see latestTrainingLoad), so zeros don't count as data.
export function endOfWeekCtl(wellness: WellnessEntry[], weekStart: string): number {
  const ctlByDate = new Map(wellness.filter((w) => w.ctl > 0).map((w) => [w.date, w.ctl]));
  for (let i = 6; i >= 0; i--) {
    const ctl = ctlByDate.get(addLocalDays(weekStart, i));
    if (ctl !== undefined) return ctl;
  }
  return 0;
}

// The Monday-aligned span to report: `weeksBack` full weeks plus the current
// one, so only the last row is partial. Wellness starts a week earlier to give
// the first row a real ramp.
export function reviewRange(
  today: string,
  weeksBack: number,
): { firstWeek: string; wellnessStart: string } {
  const firstWeek = weekKey(addLocalDays(today, -weeksBack * 7));
  if (!firstWeek) throw new Error(`Invalid date: ${today}`);
  return { firstWeek, wellnessStart: addLocalDays(firstWeek, -7) };
}

const EMPTY_WEEK: WeekSummary = {
  tss: 0,
  hours: 0,
  rides: 0,
  weights: 0,
  z12s: 0,
  hards: 0,
  longRide: 0,
  byType: {},
};

export function formatWeeklyReview(
  weeks: Map<string, WeekSummary>,
  wellness: WellnessEntry[],
  range: { firstWeek: string; today: string; weeksBack: number },
): string {
  const { firstWeek, today, weeksBack } = range;
  if (weeks.size === 0) return `\nNo activities in the last ${weeksBack} weeks.\n`;
  const lastWeek = weekKey(today);
  // Every week gets a row, so a week off is visible and each ramp spans one week.
  const keys: string[] = [];
  for (let k = firstWeek; lastWeek && k <= lastWeek; k = addLocalDays(k, 7)) keys.push(k);
  const lines = [
    `\nWeekly training review — last ${weeksBack} weeks plus this week (${firstWeek} → ${lastWeek})\n`,
    "week start   TSS   hrs  rides  wt   easy%  long   CTL  ramp   mix (TSS by type)",
    "─".repeat(92),
  ];
  let prevCtl = endOfWeekCtl(wellness, addLocalDays(firstWeek, -7));
  for (const k of keys) {
    const w = weeks.get(k) ?? EMPTY_WEEK;
    const zoneTotal = w.z12s + w.hards;
    const easyPct = zoneTotal ? Math.round((w.z12s / zoneTotal) * 100) : NaN;
    const ctl = endOfWeekCtl(wellness, k);
    // Unknown when either side has no CTL: a gap isn't a real drop or rise.
    const ramp = ctl && prevCtl ? ctl - prevCtl : null;
    prevCtl = ctl;
    const rampText = ramp === null ? "—" : (ramp >= 0 ? "+" : "") + ramp.toFixed(1);
    const mix = Object.entries(w.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, v]) => `${t} ${Math.round(v)}`)
      .join(", ");
    lines.push(
      `${k}  ${String(Math.round(w.tss)).padStart(4)}  ${w.hours.toFixed(1).padStart(4)}   ${String(w.rides).padStart(2)}   ${String(w.weights).padStart(2)}   ${(isNaN(easyPct) ? "  —" : easyPct + "%").padStart(4)}  ${w.longRide.toFixed(1).padStart(4)}  ${ctl ? ctl.toFixed(1).padStart(5) : "    —"}  ${rampText}   ${mix}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
