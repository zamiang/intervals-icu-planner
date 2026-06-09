import type { Zone } from "./zones.js";

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

export interface Config {
  weight_training: WorkoutDefinition;
  sweet_spot: WorkoutDefinition;
  scheduling: SchedulingConfig;
  load_targets: LoadTargetsConfig;
}

// --- Intervals.icu ---

export interface IntervalsEvent {
  id?: number;
  start_date_local: string; // YYYY-MM-DD
  name: string;
  category: string; // "WORKOUT", "NOTE", etc.
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
}

export interface Activity {
  id: string;
  start_date_local: string; // ISO timestamp from the API; we don't trim it
  type: string; // "Ride", "VirtualRide", "Run", etc.
  icu_training_load: number; // TSS
  icu_intensity: number | null; // IF, when available (null for non-power activities)
  icu_zone_times: number[] | null; // seconds in each power zone, when available
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
  completedDates?: string[]; // YYYY-MM-DD dates that already have a logged activity; locked like existing events
}
