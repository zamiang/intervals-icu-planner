import type { PlannedWorkout } from "./types.js";

// Intervals.icu renders per-interval targets — and pushes them to the Companion
// app — only when an event's description is written in its plain-text workout
// syntax. Given that syntax, it computes **target watts** from the athlete's
// stored FTP (power steps, written as `% FTP`) and **target heart rate** from
// their stored HR zones (HR steps, written as `Z<n> HR` or `% LTHR`). Free-text
// descriptions are shown verbatim and yield no targets, which is why the prose
// descriptions we used before never surfaced power or HR on the calendar.
//
// A step targets one primary metric (power *or* HR), so we pace the quality work
// by power (sweet spot) and the aerobic base by heart rate (easy/long Z2) — each
// derived from the athlete's own stored zones.
export interface StructuredWorkout {
  text: string; // plain-text workout for the event description
  minutes: number; // total step duration, so callers can keep planned load consistent
}

// A steady Zone 2 endurance ride paced by heart rate. `Z2 HR` makes Intervals.icu
// resolve the target bpm band from the athlete's stored HR zones.
export function easyEnduranceWorkout(minutes: number): StructuredWorkout {
  return {
    text: `- ${minutes}m Z2 HR Steady Zone 2 endurance`,
    minutes,
  };
}

// The weekly sweet-spot session, paced by power off stored FTP: an easy warmup
// with threshold openers, 3x12 min at 88-94% FTP, and an easy cooldown. The
// full coaching rationale lives in config.yaml / docs; the event carries the
// executable structure plus short per-step labels.
export function sweetSpotWorkout(): StructuredWorkout {
  const text = [
    "Warmup",
    "- 10m 55-70% 90rpm Easy Zone 2 spin",
    "",
    "Openers 3x",
    "- 30s 95-100% 95rpm Threshold opener",
    "- 30s 50-55% Easy spin",
    "",
    "Main Set 3x",
    "- 12m 88-94% Sweet spot",
    "- 5m 50-55% Easy recovery spin",
    "",
    "Cooldown",
    "- 8m 45-55% Easy Zone 1 spin",
  ].join("\n");
  // 10 warmup + 3x(0.5+0.5) openers + 3x(12+5) main + 8 cooldown
  const minutes = 10 + 3 * (0.5 + 0.5) + 3 * (12 + 5) + 8;
  return { text, minutes };
}

// Map a scheduler-planned workout to a structured workout, when one can be
// generated deterministically. Hard Xert rides (workout-of-the-day, no fixed
// structure), weights (no power/HR model), and rest days return null and keep
// their prose descriptions.
export function structuredWorkoutFor(w: PlannedWorkout): StructuredWorkout | null {
  if (w.type === "sweet_spot") return sweetSpotWorkout();
  if (w.type === "cycling" && w.intensity === "easy" && typeof w.durationMin === "number") {
    return easyEnduranceWorkout(w.durationMin);
  }
  return null;
}
