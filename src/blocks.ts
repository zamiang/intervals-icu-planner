import type { Config, HardZone, IntervalsEvent, PlannedWorkout, TrainingBlock } from "./types.js";

// Season layer. The weekly planner decides *how hard this week* from TSB and
// readiness; blocks decide *what this stretch of the season is for* — a
// date-ranged focus that switches on and off by itself instead of living as a
// hand-edited config value with a "revisit around <date>" comment.

// CTL is a 42-day exponentially weighted average of daily TSS, so one week
// moves it this fraction of the way toward the week's average daily load.
export const CTL_WEEK_RESPONSE = 1 - Math.exp(-7 / 42);

// The block covering `date` (inclusive on both ends). Blocks are validated as
// non-overlapping at load time, so at most one matches.
export function activeBlock(
  date: string,
  blocks: TrainingBlock[] | undefined,
): TrainingBlock | undefined {
  return (blocks ?? []).find((b) => date >= b.start_date && date <= b.end_date);
}

// A block that sets hard_zone_focus (null included — "no focus this block")
// overrides scheduling.hard_zone_focus; one that leaves it out inherits it.
export function hardZoneFocusOn(date: string, config: Config): HardZone | null {
  const block = activeBlock(date, config.blocks);
  if (block && block.hard_zone_focus !== undefined) return block.hard_zone_focus;
  return config.scheduling.hard_zone_focus;
}

// 1-based week of the block that `date` falls in, and the block's total weeks.
export function blockWeek(date: string, block: TrainingBlock): { week: number; of: number } {
  const days = (a: string, b: string): number =>
    Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
  return {
    week: Math.floor(days(block.start_date, date) / 7) + 1,
    of: Math.ceil((days(block.start_date, block.end_date) + 1) / 7),
  };
}

// CTL a week from now if `weeklyTss` is what gets ridden.
export function projectCtl(ctl: number, weeklyTss: number): number {
  return ctl + CTL_WEEK_RESPONSE * (weeklyTss / 7 - ctl);
}

// Weekly TSS that lands end-of-week CTL on `floor`, capped at the load the
// ramp guard would allow — climbing back after a break still respects
// max_weekly_ramp_pct rather than prescribing a crash rebuild. This is the
// week's total, not a top-up: callers compare it against their planned week.
// With CTL 0 (no wellness data at all) the ramp cap is 0 too, so the floor
// abstains rather than prescribe load from nothing.
export function floorTargetTss(ctl: number, floor: number, maxRampPct: number): number {
  const reachFloor = ctl + (floor - ctl) / CTL_WEEK_RESPONSE;
  const rampCap = ctl * (1 + maxRampPct / 100 / CTL_WEEK_RESPONSE);
  return Math.max(0, Math.round(7 * Math.min(reachFloor, rampCap)));
}

// Planned TSS the week will carry: the generated workouts plus whatever
// already sits on the calendar inside the 7-day window (a hand-added ride
// counts toward the floor as much as a generated one).
export function windowTss(
  planned: PlannedWorkout[],
  existing: IntervalsEvent[],
  startDate: string,
  days = 7,
): number {
  const end = new Date(startDate);
  end.setUTCDate(end.getUTCDate() + days - 1);
  const endStr = end.toISOString().slice(0, 10);
  const existingTss = existing
    .filter((e) => {
      const d = e.start_date_local.slice(0, 10);
      return d >= startDate && d <= endStr && e.category !== "HOLIDAY";
    })
    .reduce((s, e) => s + (e.icu_training_load ?? 0), 0);
  return planned.reduce((s, w) => s + (w.load ?? 0), 0) + existingTss;
}
