import type { Zone } from "./zones.js";
import type { ReadinessSignal } from "./readiness.js";

// --- Config ---

export interface WorkoutDefinition {
  name: string;
  duration_minutes: number;
  description: string;
}

export interface SchedulingConfig {
  tsb_fresh: number; // default 5
  tsb_fatigued: number; // default -10
  tsb_very_fatigued: number; // default -20 — below this, drop sweet-spot and reduce weights
  weight_sessions: number; // default 2
  weight_sessions_very_fatigued: number; // default 1 — weight sessions when TSB < tsb_very_fatigued
  weight_sessions_taper: number; // default 1 — weight sessions/week during the race taper
  min_weight_gap_days: number; // default 2
  max_weekly_ramp_pct: number; // default 7 — CTL ramp above this triggers an easy-bias guard
  hard_cycling_days: number; // default 1 — max hard interval rides/week (beyond the sweet-spot day); the 80/20 cap. Remaining days fill easy.
}

// Planned-load targets the scheduler attaches to each generated workout so the
// calendar shows TSS/duration/IF and Intervals.icu folds them into planned CTL.
// TSS is derived as (minutes / 60) * IF^2 * 100.
export interface LoadTargetsConfig {
  easy_if: number; // default 0.62 — intensity factor for easy Zone 2 fills
  easy_minutes: number; // default 75 — duration of a standard easy ride
  long_minutes: number; // default 180 — the one weekly long endurance ride (century durability)
  hard_if: number; // default 0.88 — intensity factor for hard interval rides
  hard_minutes: number; // default 75 — duration of a hard interval ride
  sweet_spot_if: number; // default 0.88 — IF applied to the sweet_spot session (duration from its WorkoutDefinition)
}

export interface PeriodizationConfig {
  taper_weeks: number; // default 4 — fewer weeks-to-race than this → taper phase
  taper_zero_weeks: number; // default 1 — fewer weeks-to-race than this → no strength
  race_date: string | null; // default null — ISO date fallback when no RACE_A event exists
}

// Readiness from the HRV / resting-HR trend in Intervals.icu wellness. A short
// trailing window is compared to a longer rolling baseline; a meaningful drop
// downgrades the week one fatigue tier (it never upgrades). Defaults are the
// "conservative" preset — only react to a clear, sustained drop.
export interface ReadinessConfig {
  enabled: boolean; // default true — when false the scheduler ignores HRV/RHR entirely
  recent_days: number; // default 4 — trailing window averaged as "today's" readiness
  baseline_days: number; // default 28 — window preceding the recent one used as the baseline
  min_baseline_samples: number; // default 14 — need this many baseline readings or we abstain
  hrv_drop_sd: number; // default 1.5 — recent HRV ≤ baseline_mean − this·SD ⇒ suppressed
  rhr_rise_bpm: number; // default 7 — recent resting HR ≥ baseline_median + this ⇒ suppressed
  rhr_artifact_bpm: number; // default 25 — resting HR ≥ baseline_median + this is a sensor artifact (e.g. a ride file's bogus "resting HR" overwriting the wellness value), not physiology, and is dropped before the median. Well above rhr_rise_bpm so a real alarm still fires.
}

export interface Config {
  weight_training: WorkoutDefinition;
  weight_training_taper?: WorkoutDefinition; // optional; falls back to weight_training
  sweet_spot: WorkoutDefinition;
  scheduling: SchedulingConfig;
  load_targets: LoadTargetsConfig;
  periodization: PeriodizationConfig;
  readiness: ReadinessConfig;
}

// --- Intervals.icu ---

export interface IntervalsEvent {
  id?: number;
  start_date_local: string; // we write YYYY-MM-DD; the API returns it with a time component (e.g. "2026-04-21T00:00:00") on read — normalize before comparing
  name: string;
  category?: string; // "WORKOUT", "NOTE", "RACE_A", etc. (read for race detection)
  description?: string;
  type?: string; // "Ride", "WeightTraining", etc.
  // Planned-load targets. When set, Intervals.icu shows the workout's target
  // TSS/duration/IF on the calendar and folds it into the planned CTL/ATL curve.
  icu_training_load?: number; // planned TSS
  moving_time?: number; // planned duration, seconds
  icu_intensity?: number; // planned intensity factor (IF), e.g. 0.75
}

export interface TrainingLoad {
  ctl: number; // chronic training load (fitness)
  atl: number; // acute training load (fatigue)
  tsb: number; // training stress balance (form)
}

export interface WellnessEntry extends TrainingLoad {
  date: string; // YYYY-MM-DD (from the wellness `id` field)
  hrvSDNN?: number; // ms (Intervals.icu `hrvSDNN`); absent on days with no morning reading
  restingHR?: number; // bpm (Intervals.icu `restingHR`); absent on days with no morning reading
}

export interface Activity {
  id: string;
  start_date_local: string; // ISO timestamp from the API; we don't trim it
  start_date: string; // UTC ISO timestamp ("...Z"); used to match against external logs (e.g. Hevy) without timezone guesswork
  type: string; // "Ride", "VirtualRide", "Run", etc.
  icu_training_load: number; // TSS
  icu_intensity: number | null; // IF as a fraction, e.g. 0.89 (the API returns a percentage; normalized on read)
  icu_zone_times: number[] | null; // seconds in Z1..Z7 (normalized from the API's object form on read)
  icu_ss_time: number | null; // seconds in the native sweet-spot ("SS") band; overlaps Z3/Z4, so not part of icu_zone_times
}

// --- Xert ---

export interface XertTrainingInfo {
  ftp: number;
  ltp: number;
  hie: number;
  pp: number; // peak power
  training_status: string;
  focus: string; // recommended focus type
  wotd_name?: string;
  wotd_description?: string;
}

// --- Scheduler ---

export type WorkoutType = "cycling" | "sweet_spot" | "weights" | "rest";

export type CyclingIntensity = "easy" | "moderate" | "hard";

export interface PlannedWorkout {
  date: string; // YYYY-MM-DD
  type: WorkoutType;
  name: string;
  description: string;
  intensity: CyclingIntensity | "hard"; // weights and sweet_spot are always "hard"
  targetZone?: Zone; // set on hard cycling days when zone distribution is supplied
  // Planned-load targets, attached by the scheduler and pushed to Intervals.icu.
  load?: number; // planned TSS (icu_training_load)
  durationMin?: number; // planned duration in minutes (pushed as moving_time seconds)
  intensityFactor?: number; // planned IF (icu_intensity); omitted for weights
}

export interface SchedulerInput {
  startDate: string; // YYYY-MM-DD, first day of planning window
  existingEvents: IntervalsEvent[];
  trainingLoad: TrainingLoad;
  xertInfo: XertTrainingInfo;
  config: Config;
  zoneDistribution?: Record<Zone, number>; // trailing TSS-weighted zone mix
  rampRatePct?: number; // trailing-week CTL ramp; triggers guard above threshold
  completedDates?: string[]; // dates with a logged activity; locked like existing events. Callers pass YYYY-MM-DD, but the scheduler normalizes to the date prefix so timestamps are accepted too
  weeksToRace?: number; // whole weeks until the A race; undefined when no race is known
  readiness?: ReadinessSignal; // HRV/RHR readiness; absent ⇒ scheduler behaves exactly as before
}
