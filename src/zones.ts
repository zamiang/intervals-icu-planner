import type { Activity } from "./types.js";

export type Zone = "endurance" | "tempo" | "sweet_spot" | "threshold" | "vo2" | "anaerobic";

export const ZONES: Zone[] = ["endurance", "tempo", "sweet_spot", "threshold", "vo2", "anaerobic"];

// Pyramidal-leaning baseline: ~55% endurance, ~30% Z3-Z4 (tempo / sweet_spot /
// threshold), ~20% above (vo2 / anaerobic). Not strictly polarized — picked to
// match how a self-coached enthusiast actually trains, not an elite athlete.
// Targets are TSS-weighted fractions; sum is 1.
export const POLARIZED_TARGETS: Record<Zone, number> = {
  endurance: 0.55,
  tempo: 0.05,
  sweet_spot: 0.1,
  threshold: 0.1,
  vo2: 0.15,
  anaerobic: 0.05,
};

// Hard-day candidates. Endurance and tempo are not "hard ride" targets — they
// fill themselves in via the easy/moderate cycling fills.
export const HARD_ZONES: Zone[] = ["sweet_spot", "threshold", "vo2", "anaerobic"];

// Power-zone-time index → primary Zone. icu_zone_times is normalized to a
// 7-element array of seconds (Z1..Z7) by IntervalsClient. The API's native
// sweet-spot ("SS") bucket overlaps Z3/Z4 and is carried separately on
// Activity.icu_ss_time.
const ZONE_TIMES_TO_ZONE: Zone[] = [
  "endurance", // Z1: active recovery
  "endurance", // Z2: endurance
  "tempo", // Z3
  "threshold", // Z4
  "vo2", // Z5
  "anaerobic", // Z6
  "anaerobic", // Z7
];

function classifyByIF(intensity: number): Zone {
  if (intensity <= 0.75) return "endurance";
  if (intensity <= 0.83) return "tempo";
  if (intensity <= 0.93) return "sweet_spot";
  if (intensity <= 1.04) return "threshold";
  if (intensity <= 1.2) return "vo2";
  return "anaerobic";
}

function dominantZoneFromTimes(times: number[]): Zone | null {
  let maxIdx = -1;
  let maxVal = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] > maxVal) {
      maxVal = times[i];
      maxIdx = i;
    }
  }
  if (maxIdx < 0) return null;
  return ZONE_TIMES_TO_ZONE[maxIdx] ?? null;
}

export function classifyActivity(a: Activity): Zone | null {
  // Only classify rides — runs and other activities don't fit the cycling
  // power-zone model the scheduler uses.
  if (!/Ride/i.test(a.type)) return null;
  if (a.icu_training_load <= 0) return null;

  if (a.icu_zone_times && a.icu_zone_times.some((t) => t > 0)) {
    // The SS bucket double-counts seconds that also sit in Z3/Z4, so it can't
    // join the dominant-zone scan — but when it outweighs every individual
    // zone, sweet spot is the ride's real focus.
    if (a.icu_ss_time != null && a.icu_ss_time > Math.max(...a.icu_zone_times)) {
      return "sweet_spot";
    }
    const z = dominantZoneFromTimes(a.icu_zone_times);
    if (z) return z;
  }
  if (a.icu_intensity != null && a.icu_intensity > 0) {
    return classifyByIF(a.icu_intensity);
  }
  return null;
}

export function emptyDistribution(): Record<Zone, number> {
  return {
    endurance: 0,
    tempo: 0,
    sweet_spot: 0,
    threshold: 0,
    vo2: 0,
    anaerobic: 0,
  };
}

export function computeDistribution(activities: Activity[]): Record<Zone, number> {
  const acc = emptyDistribution();
  let total = 0;
  for (const a of activities) {
    const z = classifyActivity(a);
    if (!z) continue;
    acc[z] += a.icu_training_load;
    total += a.icu_training_load;
  }
  if (total === 0) return acc;
  for (const z of ZONES) acc[z] /= total;
  return acc;
}

// Most under-target hard zone, skipping any in `exclude`. Returns undefined
// when every hard zone is excluded — the caller must decide what a hard day
// with no zone left to assign means. Crucially this never falls back to an
// excluded zone: seeding `best` with HARD_ZONES[0] (sweet_spot) and returning it
// unconditionally would hand back sweet_spot once all zones are used, silently
// reintroducing the duplicate-sweet-spot session the exclude set exists to prevent.
export function mostDeficientZone(
  actual: Record<Zone, number>,
  targets: Record<Zone, number> = POLARIZED_TARGETS,
  exclude: Set<Zone> = new Set(),
): Zone | undefined {
  let best: Zone | undefined;
  let bestDeficit = -Infinity;
  for (const z of HARD_ZONES) {
    if (exclude.has(z)) continue;
    const deficit = (targets[z] ?? 0) - (actual[z] ?? 0);
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      best = z;
    }
  }
  return best;
}

const ZONE_LABELS: Record<Zone, string> = {
  endurance: "Endurance",
  tempo: "Tempo",
  sweet_spot: "Sweet Spot",
  threshold: "Threshold",
  vo2: "VO2 Max",
  anaerobic: "Anaerobic",
};

export function zoneLabel(z: Zone): string {
  return ZONE_LABELS[z];
}
