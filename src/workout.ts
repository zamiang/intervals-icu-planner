import type { PlannedWorkout } from "./types.js";
import type { Zone } from "./zones.js";

// Intervals.icu renders per-interval targets — and pushes them to the Companion
// app — only when an event's description is written in its plain-text workout
// syntax. Given that syntax, it computes **target watts** from the athlete's
// stored FTP (power steps, written as `% FTP`) and **target heart rate** from
// their stored HR zones (HR steps, written as `Z<n> HR` or `% LTHR`). Free-text
// descriptions are shown verbatim and yield no targets, which is why the prose
// descriptions we used before never surfaced power or HR on the calendar.
//
// Steps pace the quality work by power (sweet spot) and the aerobic base by
// heart rate (easy/long Z2). Crucially, the endurance steps carry BOTH a power
// target and an HR-zone target: Intervals.icu cannot estimate power for an
// HR-only planned step (normalized_power stays 0), so it can't forecast load —
// the power target gives it something to compute from while the HR zone is what
// the athlete actually paces to. All targets derive from the athlete's own
// stored zones.
export interface StructuredWorkout {
  text: string; // plain-text workout for the event description
  minutes: number; // total step duration, so callers can keep planned load consistent
  // The effective IF the steps encode, when the workout is a single steady
  // effort (e.g. endurance). Callers compute planned load from this so the
  // submitted TSS matches the integer power % actually written into the step.
  // Omitted for mixed workouts (e.g. sweet spot) whose IF varies across steps.
  intensityFactor?: number;
}

// A steady Zone 2 endurance ride carrying BOTH a power target and an HR-zone
// target. The power target (`{ftpPct}%`) is what Intervals.icu uses to compute
// planned load/CTL — an HR-only step leaves normalized_power at 0, so it can't
// forecast TSS and falls back to a broken ~33% estimate. `Z2 HR` then pins the
// heart-rate target so the athlete still sees the stored-zone bpm band. The
// power target is the planned IF rounded to a whole percent; the returned
// intensityFactor mirrors that rounding so the submitted TSS matches the step.
export function easyEnduranceWorkout(minutes: number, ftpPct: number): StructuredWorkout {
  return {
    text: `- ${minutes}m ${ftpPct}% Z2 HR Steady Zone 2 endurance`,
    minutes,
    intensityFactor: ftpPct / 100,
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

// A hard interval session, one per zone the scheduler targets. Each is a
// classic prescription for its energy system, written as power steps off stored
// FTP so Intervals.icu renders per-interval target watts and pushes them to the
// Companion app. This is what makes a hard day self-constructed rather than
// dependent on an external workout-of-the-day. These are mixed-IF workouts (no
// single intensityFactor), so planned load is computed from the scheduler's
// attached load_targets.hard_if over the structured duration, exactly as the
// sweet-spot session already is.
interface IntervalSpec {
  label: string; // step label + shown in the calendar
  reps: number; // number of work intervals
  onMin: number; // work-interval length, minutes
  power: string; // work-interval power band as `% FTP`, e.g. "110-118%"
  offMin: number; // recovery length between intervals, minutes
}

function intervalSession(s: IntervalSpec): StructuredWorkout {
  const text = [
    "Warmup",
    "- 12m 55-70% 90rpm Easy Zone 2 spin",
    "",
    "Openers 2x",
    "- 30s 100-105% 95rpm Threshold opener",
    "- 30s 50-55% Easy spin",
    "",
    `Main Set ${s.reps}x`,
    `- ${s.onMin}m ${s.power} ${s.label}`,
    `- ${s.offMin}m 50-55% Easy recovery spin`,
    "",
    "Cooldown",
    "- 8m 45-55% Easy Zone 1 spin",
  ].join("\n");
  // 12 warmup + 2x(0.5+0.5) openers + reps x(on+off) main + 8 cooldown
  const minutes = 12 + 2 * (0.5 + 0.5) + s.reps * (s.onMin + s.offMin) + 8;
  return { text, minutes };
}

export function hardIntervalWorkout(zone: Zone): StructuredWorkout {
  // Exhaustive over Zone (no `default`) so adding a zone is a compile error here
  // rather than a silent fallback to the wrong session. The scheduler only ever
  // targets threshold / vo2 / anaerobic on hard-cycling days (sweet_spot is
  // handled by its own phase), but the remaining zones map to sane sessions so
  // any caller stays correct.
  switch (zone) {
    case "threshold":
      return intervalSession({
        label: "Threshold",
        reps: 4,
        onMin: 8,
        power: "95-102%",
        offMin: 4,
      });
    case "vo2":
      return intervalSession({ label: "VO2 Max", reps: 5, onMin: 3, power: "110-118%", offMin: 3 });
    case "anaerobic":
      return intervalSession({
        label: "Anaerobic",
        reps: 8,
        onMin: 1,
        power: "125-140%",
        offMin: 2,
      });
    // A legitimately different structured session (3x12 min @ 88-94%), not a
    // short-interval format — its own case, not a shared fallback.
    case "sweet_spot":
      return sweetSpotWorkout();
    // Not hard-day zones (see HARD_ZONES) and unreachable from the scheduler,
    // but the type permits them; a steady sweet-spot session is the safe map.
    case "endurance":
    case "tempo":
      return sweetSpotWorkout();
  }
}

// Map a scheduler-planned workout to a structured workout, when one can be
// generated deterministically. Hard cycling days build the interval session for
// their target zone; weights (no power/HR model) and rest days return null and
// keep their prose descriptions.
export function structuredWorkoutFor(w: PlannedWorkout): StructuredWorkout | null {
  if (w.type === "sweet_spot") return sweetSpotWorkout();
  if (w.type === "cycling" && w.intensity === "hard" && w.targetZone) {
    return hardIntervalWorkout(w.targetZone);
  }
  if (
    w.type === "cycling" &&
    w.intensity === "easy" &&
    typeof w.durationMin === "number" &&
    typeof w.intensityFactor === "number"
  ) {
    return easyEnduranceWorkout(w.durationMin, Math.round(w.intensityFactor * 100));
  }
  return null;
}
