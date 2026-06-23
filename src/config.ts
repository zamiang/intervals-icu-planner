import { promises as fs } from "node:fs";
import { parse } from "yaml";
import type {
  Config,
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

const READINESS_DEFAULTS: ReadinessConfig = {
  enabled: true,
  recent_days: 4,
  baseline_days: 28,
  min_baseline_samples: 14,
  hrv_drop_sd: 1.5,
  rhr_rise_bpm: 7,
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
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error("readiness.enabled must be a boolean");
    }
    out.enabled = obj.enabled;
  }
  // Exclude the boolean `enabled` key (validated above) so the indexed write
  // type stays `number` — this lets us use `as number` like the sibling
  // validators instead of an `as never` escape hatch.
  const numericFields: Exclude<keyof ReadinessConfig, "enabled">[] = [
    "recent_days",
    "baseline_days",
    "min_baseline_samples",
    "hrv_drop_sd",
    "rhr_rise_bpm",
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

  return {
    weight_training,
    weight_training_taper,
    sweet_spot,
    scheduling,
    load_targets,
    periodization,
    readiness,
  };
}
