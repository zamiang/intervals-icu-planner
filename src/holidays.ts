// HOLIDAY-awareness: which planning-window days a HOLIDAY calendar event
// covers, and what (if anything) to push on them.
//
// Two API facts drive the shape of this module (both verified against the live
// API, 2026-07-22):
//   1. The events endpoint filters on *start* date only — a holiday that began
//      before the queried range is not returned even when it overlaps it, so
//      callers must fetch with a lookback (config.holidays.lookback_days).
//   2. A multi-day event's end_date_local is an exclusive midnight bound: a
//      holiday shown Aug 2-14 on the calendar reads back as
//      start 2026-08-02T00:00:00, end 2026-08-15T00:00:00.
import { addLocalDays } from "./dates.js";
import type { HolidaysConfig, IntervalsEvent, PlannedWorkout } from "./types.js";

const dayKey = (d: string): string => d.slice(0, 10);

// Last calendar day an event covers. An end of exactly T00:00:00 on a later
// day is exclusive (see above); an end with any other time, an end equal to
// the start, or no end at all means the event is contained in its final day.
function lastCoveredDate(e: IntervalsEvent): string {
  if (!e.end_date_local) return dayKey(e.start_date_local);
  const endDate = dayKey(e.end_date_local);
  const midnightEnd =
    e.end_date_local.slice(10) === "" || e.end_date_local.slice(10) === "T00:00:00";
  if (midnightEnd && endDate > dayKey(e.start_date_local)) return addLocalDays(endDate, -1);
  return endDate;
}

// Dates (YYYY-MM-DD) within [oldest..newest] covered by HOLIDAY events.
export function holidayDatesInWindow(
  events: IntervalsEvent[],
  oldest: string,
  newest: string,
): Set<string> {
  const covered = new Set<string>();
  for (const e of events) {
    if (e.category !== "HOLIDAY") continue;
    const last = lastCoveredDate(e);
    for (let d = dayKey(e.start_date_local); d <= last; d = addLocalDays(d, 1)) {
      if (d >= oldest && d <= newest) covered.add(d);
    }
  }
  return covered;
}

// Shared placeholder content, so `plan` and `push-week` put identical events on
// the calendar. Zero load on purpose: travel days shouldn't inflate planned
// CTL, and any session actually done abroad arrives as a logged activity.
export const HOLIDAY_PLACEHOLDER = {
  name: "Travel Day — Optional Cross-Training",
  type: "Workout",
  description:
    "Holiday/travel day — no planned ride. If convenient, do some easy " +
    "cross-training: a gym session, brisk walk, hotel-bike spin, or short run. " +
    "Nothing is lost by resting instead.",
  duration_minutes: 30,
} as const;

export function holidayPlaceholderWorkout(date: string): PlannedWorkout {
  return {
    date,
    type: "travel",
    name: HOLIDAY_PLACEHOLDER.name,
    description: HOLIDAY_PLACEHOLDER.description,
    intensity: "easy",
    durationMin: HOLIDAY_PLACEHOLDER.duration_minutes,
  };
}

export function holidayPlaceholderEvent(date: string): IntervalsEvent {
  return {
    start_date_local: `${date}T00:00:00`,
    name: HOLIDAY_PLACEHOLDER.name,
    category: "WORKOUT",
    type: HOLIDAY_PLACEHOLDER.type,
    description: HOLIDAY_PLACEHOLDER.description,
    // Explicit moving_time so Intervals.icu never derives a bogus duration by
    // parsing the prose description (same guard as the strength events).
    moving_time: HOLIDAY_PLACEHOLDER.duration_minutes * 60,
  };
}

// Apply the holiday policy to a list of to-be-pushed events (push-week path):
// events on holiday days are dropped ("skip") or coalesced into one placeholder
// per day ("placeholder"). Non-holiday days pass through untouched.
export function applyHolidayPolicy(
  events: IntervalsEvent[],
  holidayDates: Set<string>,
  mode: HolidaysConfig["mode"],
): { events: IntervalsEvent[]; dropped: IntervalsEvent[] } {
  const kept: IntervalsEvent[] = [];
  const dropped: IntervalsEvent[] = [];
  const placeholderDates = new Set<string>();
  for (const e of events) {
    const date = dayKey(e.start_date_local);
    if (!holidayDates.has(date)) {
      kept.push(e);
      continue;
    }
    dropped.push(e);
    if (mode === "placeholder" && !placeholderDates.has(date)) {
      placeholderDates.add(date);
      kept.push(holidayPlaceholderEvent(date));
    }
  }
  return { events: kept, dropped };
}
