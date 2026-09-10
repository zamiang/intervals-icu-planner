import { promises as fs } from "node:fs";
import { parse } from "yaml";
import type {
  Config,
  FtpSyncConfig,
  FuelingConfig,
  HolidaysConfig,
  LoadTargetsConfig,
  PeriodizationConfig,
  ReadinessConfig,
  SchedulingConfig,
  WorkoutDefinition,
} from "./types.js";

const SCHEDULING_DEFAULTS: SchedulingConfig = {
  tsb_fresh: 5,
  tsb_fatigued: -10,
  tsb_very_fatigued: -20,
  weight_sessions: 2,
  weight_sessions_very_fatigued: 1,
  weight_sessions_taper: 1,
  min_weight_gap_days: 2,
  max_weekly_ramp_pct: 7,
  hard_cycling_days: 1,
};

const PERIODIZATION_DEFAULTS: PeriodizationConfig = {
  taper_weeks: 4,
  taper_zero_weeks: 1,
  race_date: null,
};

const LOAD_TARGETS_DEFAULTS: LoadTargetsConfig = {
  easy_if: 0.62,
  easy_minutes: 75,
  long_minutes: 180,
  hard_if: 0.88,
  hard_minutes: 75,
  sweet_spot_if: 0.88,
};

const FTP_SYNC_DEFAULTS: FtpSyncConfig = {
  enabled: true,
  max_change_pct: 10,
};

const HOLIDAYS_DEFAULTS: HolidaysConfig = {
  enabled: true,
  mode: "skip",
  lookback_days: 60,
};

const FUELING_DEFAULTS: FuelingConfig = {
  enabled: false,
  start_date: null,
  end_date: null,
  daily_deficit_kcal: 550,
  fuel_day_addback_kcal: 400,
  deficit_day_extra_kcal: 150,
  min_kcal: 1800,
  protein_g_per_kg: 2.2,
  fat_g_per_kg: 0.8,
  non_exercise_multiplier: 1.35,
  weights_kcal_per_hour: 300,
  avg_power_factor: 0.9,
  low_carb_max_minutes: 90,
  hard_min_if: 0.75,
  long_min_minutes: 150,
  hard_carb_g_per_hour: [30, 60],
  moderate_carb_g_per_hour: [60, 75],
  long_carb_g_per_hour: [60, 90],
};

const READINESS_DEFAULTS: ReadinessConfig = {
  enabled: true,
  recent_days: 4,
  baseline_days: 28,
  min_baseline_samples: 14,
  hrv_drop_sd: 1.5,
  rhr_rise_bpm: 7,
  rhr_artifact_bpm: 25,
  steps_enabled: true,
  step_threshold: 12000,
  step_lookback_days: 7,
  step_days_required: 4,
  min_step_samples: 5,
};

function validateScheduling(raw: unknown): Partial<SchedulingConfig> {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new Error("scheduling must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<SchedulingConfig> = {};
  const numericFields: (keyof SchedulingConfig)[] = [
    "tsb_fresh",
    "tsb_fatigued",
    "tsb_very_fatigued",
    "weight_sessions",
    "weight_sessions_very_fatigued",
    "weight_sessions_taper",
    "min_weight_gap_days",
    "max_weekly_ramp_pct",
    "hard_cycling_days",
  ];
  for (const field of numericFields) {
    if (obj[field] === undefined) continue;
    if (typeof obj[field] !== "number") {
      throw new Error(`scheduling.${field} must be a number`);
    }
    out[field] = obj[field] as number;
  }
  return out;
}

function validateLoadTargets(raw: unknown): Partial<LoadTargetsConfig> {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new Error("load_targets must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<LoadTargetsConfig> = {};
  const numericFields: (keyof LoadTargetsConfig)[] = [
    "easy_if",
    "easy_minutes",
    "long_minutes",
    "hard_if",
    "hard_minutes",
    "sweet_spot_if",
  ];
  for (const field of numericFields) {
    if (obj[field] === undefined) continue;
    if (typeof obj[field] !== "number") {
      throw new Error(`load_targets.${field} must be a number`);
    }
    out[field] = obj[field] as number;
  }
  return out;
}

function validateReadiness(raw: unknown): Partial<ReadinessConfig> {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new Error("readiness must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<ReadinessConfig> = {};
  const booleanFields = ["enabled", "steps_enabled"] as const;
  for (const field of booleanFields) {
    if (obj[field] === undefined) continue;
    if (typeof obj[field] !== "boolean") {
      throw new Error(`readiness.${field} must be a boolean`);
    }
    out[field] = obj[field] as boolean;
  }
  // Exclude the boolean keys (validated above) so the indexed write type stays
  // `number` — this lets us use `as number` like the sibling validators instead
  // of an `as never` escape hatch.
  const numericFields: Exclude<keyof ReadinessConfig, (typeof booleanFields)[number]>[] = [
    "recent_days",
    "baseline_days",
    "min_baseline_samples",
    "hrv_drop_sd",
    "rhr_rise_bpm",
    "rhr_artifact_bpm",
    "step_threshold",
    "step_lookback_days",
    "step_days_required",
    "min_step_samples",
  ];
  for (const field of numericFields) {
    if (obj[field] === undefined) continue;
    if (typeof obj[field] !== "number") {
      throw new Error(`readiness.${field} must be a number`);
    }
    out[field] = obj[field] as number;
  }
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateFueling(raw: unknown): Partial<FuelingConfig> {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new Error("fueling must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<FuelingConfig> = {};

  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error("fueling.enabled must be a boolean");
    }
    out.enabled = obj.enabled;
  }

  for (const field of ["start_date", "end_date"] as const) {
    if (obj[field] === undefined) continue;
    if (obj[field] === null) {
      out[field] = null;
      continue;
    }
    if (typeof obj[field] !== "string" || !ISO_DATE.test(obj[field] as string)) {
      throw new Error(`fueling.${field} must be null or a YYYY-MM-DD date`);
    }
    out[field] = obj[field] as string;
  }

  const numericFields = [
    "daily_deficit_kcal",
    "fuel_day_addback_kcal",
    "deficit_day_extra_kcal",
    "min_kcal",
    "protein_g_per_kg",
    "fat_g_per_kg",
    "non_exercise_multiplier",
    "weights_kcal_per_hour",
    "avg_power_factor",
    "low_carb_max_minutes",
    "hard_min_if",
    "long_min_minutes",
  ] as const;
  for (const field of numericFields) {
    if (obj[field] === undefined) continue;
    if (typeof obj[field] !== "number" || !Number.isFinite(obj[field])) {
      throw new Error(`fueling.${field} must be a number`);
    }
    out[field] = obj[field] as number;
  }

  const rangeFields = [
    "hard_carb_g_per_hour",
    "moderate_carb_g_per_hour",
    "long_carb_g_per_hour",
  ] as const;
  for (const field of rangeFields) {
    if (obj[field] === undefined) continue;
    const v = obj[field];
    if (
      !Array.isArray(v) ||
      v.length !== 2 ||
      !v.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      throw new Error(`fueling.${field} must be a [low, high] pair of numbers`);
    }
    if ((v[0] as number) > (v[1] as number)) {
      throw new Error(`fueling.${field} low bound must not exceed the high bound`);
    }
    out[field] = [v[0] as number, v[1] as number];
  }

  return out;
}

function validateFtpSync(raw: unknown): Partial<FtpSyncConfig> {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new Error("ftp_sync must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<FtpSyncConfig> = {};
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error("ftp_sync.enabled must be a boolean");
    }
    out.enabled = obj.enabled;
  }
  if (obj.max_change_pct !== undefined) {
    if (typeof obj.max_change_pct !== "number" || obj.max_change_pct <= 0) {
      throw new Error("ftp_sync.max_change_pct must be a positive number");
    }
    out.max_change_pct = obj.max_change_pct;
  }
  return out;
}

function validateHolidays(raw: unknown): Partial<HolidaysConfig> {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new Error("holidays must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<HolidaysConfig> = {};
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error("holidays.enabled must be a boolean");
    }
    out.enabled = obj.enabled;
  }
  if (obj.mode !== undefined) {
    if (obj.mode !== "skip" && obj.mode !== "placeholder") {
      throw new Error('holidays.mode must be "skip" or "placeholder"');
    }
    out.mode = obj.mode;
  }
  if (obj.lookback_days !== undefined) {
    if (typeof obj.lookback_days !== "number" || obj.lookback_days < 0) {
      throw new Error("holidays.lookback_days must be a non-negative number");
    }
    out.lookback_days = obj.lookback_days;
  }
  return out;
}

function validatePeriodization(raw: unknown): Partial<PeriodizationConfig> {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new Error("periodization must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<PeriodizationConfig> = {};
  for (const field of ["taper_weeks", "taper_zero_weeks"] as const) {
    if (obj[field] === undefined) continue;
    if (typeof obj[field] !== "number") {
      throw new Error(`periodization.${field} must be a number`);
    }
    out[field] = obj[field] as number;
  }
  if (obj.race_date !== undefined) {
    if (obj.race_date !== null && typeof obj.race_date !== "string") {
      throw new Error("periodization.race_date must be a string or null");
    }
    out.race_date = obj.race_date as string | null;
  }
  return out;
}

function validateWorkout(raw: unknown, field: string): WorkoutDefinition {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Config missing required field: ${field}`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string") {
    throw new Error(`${field}.name must be a string`);
  }
  if (typeof obj.duration_minutes !== "number") {
    throw new Error(`${field}.duration_minutes must be a number`);
  }
  if (typeof obj.description !== "string") {
    throw new Error(`${field}.description must be a string`);
  }
  return {
    name: obj.name,
    duration_minutes: obj.duration_minutes,
    description: obj.description,
  };
}

function validateOptionalWorkout(raw: unknown, field: string): WorkoutDefinition | undefined {
  if (raw == null) return undefined;
  return validateWorkout(raw, field);
}

export async function loadConfig(filePath: string): Promise<Config> {
  const raw = await fs.readFile(filePath, "utf8");
  const doc = parse(raw);

  if (!doc || typeof doc !== "object") {
    throw new Error("Config file is empty or invalid YAML");
  }

  const weight_training = validateWorkout(doc.weight_training, "weight_training");
  const sweet_spot = validateWorkout(doc.sweet_spot, "sweet_spot");
  const weight_training_taper = validateOptionalWorkout(
    doc.weight_training_taper,
    "weight_training_taper",
  );

  const scheduling: SchedulingConfig = {
    ...SCHEDULING_DEFAULTS,
    ...validateScheduling(doc.scheduling),
  };

  const load_targets: LoadTargetsConfig = {
    ...LOAD_TARGETS_DEFAULTS,
    ...validateLoadTargets(doc.load_targets),
  };

  const periodization: PeriodizationConfig = {
    ...PERIODIZATION_DEFAULTS,
    ...validatePeriodization(doc.periodization),
  };

  const readiness: ReadinessConfig = {
    ...READINESS_DEFAULTS,
    ...validateReadiness(doc.readiness),
  };

  const ftp_sync: FtpSyncConfig = {
    ...FTP_SYNC_DEFAULTS,
    ...validateFtpSync(doc.ftp_sync),
  };

  const holidays: HolidaysConfig = {
    ...HOLIDAYS_DEFAULTS,
    ...validateHolidays(doc.holidays),
  };

  const fueling: FuelingConfig = {
    ...FUELING_DEFAULTS,
    ...validateFueling(doc.fueling),
  };
  // An inverted window would silently disable the block rather than fail, and a
  // cut that quietly stops prescribing is worse than one that refuses to start.
  if (fueling.start_date && fueling.end_date && fueling.start_date > fueling.end_date) {
    throw new Error(
      `fueling.start_date (${fueling.start_date}) must not be after fueling.end_date (${fueling.end_date})`,
    );
  }
  // The artifact ceiling must sit above the alarm threshold, or the filter would
  // drop genuine elevations before they can trip suppression — a self-defeating
  // config that fails silently otherwise.
  if (readiness.rhr_artifact_bpm <= readiness.rhr_rise_bpm) {
    throw new Error(
      `readiness.rhr_artifact_bpm (${readiness.rhr_artifact_bpm}) must be greater than ` +
        `rhr_rise_bpm (${readiness.rhr_rise_bpm}) — the artifact filter would suppress genuine alarms`,
    );
  }
  // A window that cannot hold the days it demands would make the step signal
  // permanently unreachable — silently disabling it rather than erroring.
  if (readiness.step_days_required > readiness.step_lookback_days) {
    throw new Error(
      `readiness.step_days_required (${readiness.step_days_required}) must not exceed ` +
        `step_lookback_days (${readiness.step_lookback_days}) — the step signal could never fire`,
    );
  }
  // Likewise, demanding more populated days than the window holds means the
  // coverage guard never passes and the signal abstains forever.
  if (readiness.min_step_samples > readiness.step_lookback_days) {
    throw new Error(
      `readiness.min_step_samples (${readiness.min_step_samples}) must not exceed ` +
        `step_lookback_days (${readiness.step_lookback_days}) — the step signal could never have enough data`,
    );
  }

  return {
    weight_training,
    weight_training_taper,
    sweet_spot,
    scheduling,
    load_targets,
    periodization,
    readiness,
    ftp_sync,
    holidays,
    fueling,
  };
}
