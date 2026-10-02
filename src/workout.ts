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
  // The IF the steps encode, so callers compute planned load (and fuelling)
  // from the session the athlete will actually ride rather than a config
  // constant. Exact for a single steady effort (endurance: the integer power %
  // written into the step); estimated for mixed sessions as normalized power
  // over the band midpoints (see estimateIntensityFactor).
  intensityFactor: number;
}

// One step of a structured workout: a duration and a `% FTP` power band.
interface Step {
  min: number;
  lo: number; // % FTP
  hi: number; // % FTP
  label: string; // step label, plus any cadence cue placed before it
}

// A titled group of steps, repeated `reps` times (Intervals.icu's "Main Set 3x").
interface StepGroup {
  title: string;
  reps: number;
  steps: Step[];
}

// Normalized power over the steps, each held at its band midpoint, as a
// fraction of FTP. NP weights hard efforts by the 4th power, which is what
// makes a 3x12 sweet-spot ride (~0.80) read easier than its 88-94% main set
// and a short 5x3 VO2 ride (~0.87) read harder than its average power.
// Ignoring NP's 30-s smoothing over step edges is a negligible error at these
// step lengths. Rounded to two places; Intervals.icu's own NP from the steps
// can differ by a point or so of TSS, which is noise for planning.
export function estimateIntensityFactor(groups: StepGroup[]): number {
  let minutes = 0;
  let weighted = 0;
  for (const g of groups) {
    for (const st of g.steps) {
      const mid = (st.lo + st.hi) / 200;
      minutes += g.reps * st.min;
      weighted += g.reps * st.min * mid ** 4;
    }
  }
  return minutes > 0 ? Math.round((weighted / minutes) ** 0.25 * 100) / 100 : 0;
}

function fmtDuration(min: number): string {
  return min < 1 ? `${Math.round(min * 60)}s` : `${min}m`;
}

function renderSteps(groups: StepGroup[]): StructuredWorkout {
  const text = groups
    .map((g) =>
      [
        g.reps > 1 ? `${g.title} ${g.reps}x` : g.title,
        ...g.steps.map((st) => `- ${fmtDuration(st.min)} ${st.lo}-${st.hi}% ${st.label}`),
      ].join("\n"),
    )
    .join("\n\n");
  const minutes = groups.reduce(
    (sum, g) => sum + g.reps * g.steps.reduce((s, st) => s + st.min, 0),
    0,
  );
  return { text, minutes, intensityFactor: estimateIntensityFactor(groups) };
}

// A steady Zone 2 endurance ride carrying BOTH a power target and an HR-zone
// target. The power target is what Intervals.icu uses to compute planned
// load/CTL — an HR-only step leaves normalized_power at 0, so it can't
// forecast TSS and falls back to a broken ~33% estimate. `Z2 HR` then pins the
// heart-rate target so the athlete still sees the stored-zone bpm band.
//
// The power target is written as a band around the planned IF, not an exact
// percent: downstream integrations (Garmin, Zwift) render the step's target
// literally, and an exact watt target is unrideable outdoors — in practice it
// gets ignored wholesale and easy rides drift ~10% hot. The band gives the
// rider something they can actually hold on open roads while still bounding
// the effort. Intervals.icu derives planned load from the band midpoint, which
// is the planned IF, so the returned intensityFactor (and the TSS callers
// compute from it) still matches what Intervals.icu re-derives from the step.
const EASY_BAND_HALF_WIDTH_PCT = 6;

export function easyEnduranceWorkout(minutes: number, ftpPct: number): StructuredWorkout {
  const lo = ftpPct - EASY_BAND_HALF_WIDTH_PCT;
  const hi = ftpPct + EASY_BAND_HALF_WIDTH_PCT;
  return {
    text: `- ${minutes}m ${lo}-${hi}% Z2 HR Steady Zone 2 endurance`,
    minutes,
    intensityFactor: ftpPct / 100,
  };
}

// Main-set ladders. A block with `progression: true` climbs one rung every two
// weeks (src/blocks.ts progressionStep); outside one, rung 0 is the session.
// Each rung adds work time — progressive overload — and the last rung holds.
// Rungs keep the work band fixed until the volume has grown, then nudge it.
interface MainSet {
  reps: number;
  onMin: number;
  lo: number; // % FTP
  hi: number;
  offMin: number;
}

// 36 → 45 → 40 min longer reps → 40 at the top of the band, the sequence the
// sweet_spot rationale in config.yaml describes.
export const SWEET_SPOT_LADDER: readonly MainSet[] = [
  { reps: 3, onMin: 12, lo: 88, hi: 94, offMin: 5 },
  { reps: 3, onMin: 15, lo: 88, hi: 94, offMin: 5 },
  { reps: 2, onMin: 20, lo: 88, hi: 94, offMin: 5 },
  { reps: 2, onMin: 20, lo: 90, hi: 95, offMin: 5 },
];

// Work-interval ladders per hard zone. VO2 climbs from 15 to 25 min of work
// (studies that move VO2max typically accumulate 16-24 min); reps of 4-5 min
// drop the band slightly so the last rep is still completable.
export const INTERVAL_LADDERS: Record<"threshold" | "vo2" | "anaerobic", readonly MainSet[]> = {
  threshold: [
    { reps: 4, onMin: 8, lo: 95, hi: 102, offMin: 4 },
    { reps: 3, onMin: 12, lo: 95, hi: 102, offMin: 4 },
    { reps: 4, onMin: 10, lo: 95, hi: 102, offMin: 4 },
    { reps: 2, onMin: 20, lo: 95, hi: 100, offMin: 5 },
    { reps: 3, onMin: 15, lo: 95, hi: 100, offMin: 5 },
  ],
  vo2: [
    { reps: 5, onMin: 3, lo: 110, hi: 118, offMin: 3 },
    { reps: 6, onMin: 3, lo: 110, hi: 118, offMin: 3 },
    { reps: 5, onMin: 4, lo: 106, hi: 115, offMin: 3 },
    { reps: 6, onMin: 4, lo: 106, hi: 115, offMin: 3 },
    { reps: 5, onMin: 5, lo: 105, hi: 112, offMin: 3 },
  ],
  anaerobic: [
    { reps: 8, onMin: 1, lo: 125, hi: 140, offMin: 2 },
    { reps: 10, onMin: 1, lo: 125, hi: 140, offMin: 2 },
    { reps: 12, onMin: 1, lo: 125, hi: 140, offMin: 2 },
  ],
};

// The rung for `step`, holding at the top of the ladder (and at the bottom for
// a negative or fractional step).
export function rung(ladder: readonly MainSet[], step = 0): MainSet {
  const i = Math.min(ladder.length - 1, Math.max(0, Math.floor(step)));
  return ladder[i];
}

// The weekly sweet-spot session, paced by power off stored FTP: an easy warmup
// with threshold openers, the main set for this progression step (3x12 min at
// 88-94% FTP at rung 0), and an easy cooldown. The full coaching rationale
// lives in config.yaml / docs; the event carries the executable structure plus
// short per-step labels.
export function sweetSpotWorkout(step = 0): StructuredWorkout {
  const m = rung(SWEET_SPOT_LADDER, step);
  return renderSteps([
    {
      title: "Warmup",
      reps: 1,
      steps: [{ min: 10, lo: 55, hi: 70, label: "90rpm Easy Zone 2 spin" }],
    },
    {
      title: "Openers",
      reps: 3,
      steps: [
        { min: 0.5, lo: 95, hi: 100, label: "95rpm Threshold opener" },
        { min: 0.5, lo: 50, hi: 55, label: "Easy spin" },
      ],
    },
    {
      title: "Main Set",
      reps: m.reps,
      steps: [
        { min: m.onMin, lo: m.lo, hi: m.hi, label: "Sweet spot" },
        { min: m.offMin, lo: 50, hi: 55, label: "Easy recovery spin" },
      ],
    },
    {
      title: "Cooldown",
      reps: 1,
      steps: [{ min: 8, lo: 45, hi: 55, label: "Easy Zone 1 spin" }],
    },
  ]);
}

// A hard interval session, one per zone the scheduler targets. Each is a
// classic prescription for its energy system, written as power steps off stored
// FTP so Intervals.icu renders per-interval target watts and pushes them to the
// Companion app. This is what makes a hard day self-constructed rather than
// dependent on an external workout-of-the-day.
interface IntervalSpec extends MainSet {
  label: string; // step label + shown in the calendar
}

function intervalSession(s: IntervalSpec): StructuredWorkout {
  return renderSteps([
    {
      title: "Warmup",
      reps: 1,
      steps: [{ min: 12, lo: 55, hi: 70, label: "90rpm Easy Zone 2 spin" }],
    },
    {
      title: "Openers",
      reps: 2,
      steps: [
        { min: 0.5, lo: 100, hi: 105, label: "95rpm Threshold opener" },
        { min: 0.5, lo: 50, hi: 55, label: "Easy spin" },
      ],
    },
    {
      title: "Main Set",
      reps: s.reps,
      steps: [
        { min: s.onMin, lo: s.lo, hi: s.hi, label: s.label },
        { min: s.offMin, lo: 50, hi: 55, label: "Easy recovery spin" },
      ],
    },
    { title: "Cooldown", reps: 1, steps: [{ min: 8, lo: 45, hi: 55, label: "Easy Zone 1 spin" }] },
  ]);
}

export function hardIntervalWorkout(zone: Zone, step = 0): StructuredWorkout {
  // Exhaustive over Zone (no `default`) so adding a zone is a compile error here
  // rather than a silent fallback to the wrong session. The scheduler only ever
  // targets threshold / vo2 / anaerobic on hard-cycling days (sweet_spot is
  // handled by its own phase), but the remaining zones map to sane sessions so
  // any caller stays correct.
  switch (zone) {
    case "threshold":
      return intervalSession({ label: "Threshold", ...rung(INTERVAL_LADDERS.threshold, step) });
    case "vo2":
      return intervalSession({ label: "VO2 Max", ...rung(INTERVAL_LADDERS.vo2, step) });
    case "anaerobic":
      return intervalSession({ label: "Anaerobic", ...rung(INTERVAL_LADDERS.anaerobic, step) });
    // A legitimately different structured session (3x12 min @ 88-94%), not a
    // short-interval format — its own case, not a shared fallback.
    case "sweet_spot":
      return sweetSpotWorkout(step);
    // Not hard-day zones (see HARD_ZONES) and unreachable from the scheduler,
    // but the type permits them; a steady sweet-spot session is the safe map.
    case "endurance":
    case "tempo":
      return sweetSpotWorkout(step);
  }
}

// Map a scheduler-planned workout to a structured workout, when one can be
// generated deterministically. Hard cycling days build the interval session for
// their target zone, at the progression step the scheduler stamped on them; weights (no power/HR model) and rest days return null and
// keep their prose descriptions.
export function structuredWorkoutFor(w: PlannedWorkout): StructuredWorkout | null {
  if (w.type === "sweet_spot") return sweetSpotWorkout(w.progressionStep);
  if (w.type === "cycling" && w.intensity === "hard" && w.targetZone) {
    return hardIntervalWorkout(w.targetZone, w.progressionStep);
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
