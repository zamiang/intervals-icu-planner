import type {
  SchedulerInput,
  PlannedWorkout,
  WorkoutType,
  CyclingIntensity,
  Config,
  IntervalsEvent,
} from "./types.js";
import { mostDeficientZone, zoneLabel, type Zone } from "./zones.js";
import { holidayPlaceholderWorkout } from "./holidays.js";
import type { ReadinessSignal } from "./readiness.js";

function addDays(dateStr: string, days: number): string {
  // Parse and mutate in UTC throughout. A bare "YYYY-MM-DD" is parsed as UTC
  // midnight per spec, so staying in UTC keeps toISOString() on the same day —
  // mixing local parsing with a UTC string shifts the whole window by a day on
  // UTC+ hosts.
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Whole days from `from` to `to` (both YYYY-MM-DD, parsed as UTC midnight).
// Negative when `to` precedes `from` — events just before the window get a
// negative index so adjacency/gap math still sees them.
function dayDiff(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}

export type FatigueLevel = "fresh" | "moderate" | "fatigued" | "very_fatigued";

export function classifyFatigue(tsb: number, config: Config): FatigueLevel {
  if (tsb < config.scheduling.tsb_very_fatigued) return "very_fatigued";
  if (tsb < config.scheduling.tsb_fatigued) return "fatigued";
  if (tsb > config.scheduling.tsb_fresh) return "fresh";
  return "moderate";
}

// Suppressed readiness (HRV/RHR) pulls the week down one fatigue tier, floored
// at "fatigued". A single low-HRV morning shouldn't fire the full very_fatigued
// protocol (day-0 rest + sweet-spot drop) on its own — TSB still owns that
// deepest tier. Mirrors the ramp guard: a real recovery signal can only ever
// make the week easier, never harder.
export function downgradeOneTier(f: FatigueLevel): FatigueLevel {
  if (f === "fresh") return "moderate";
  if (f === "moderate") return "fatigued";
  return f; // fatigued / very_fatigued unchanged
}

// Fold a readiness signal into a TSB-derived fatigue tier: a suppressed signal
// downgrades one tier, anything else (normal / unknown / absent) leaves it
// unchanged. Single source of truth so schedule() and the CLI status line never
// drift on how readiness maps to a tier.
export function effectiveFatigue(
  tsbFatigue: FatigueLevel,
  readiness?: ReadinessSignal,
): FatigueLevel {
  return readiness?.status === "suppressed" ? downgradeOneTier(tsbFatigue) : tsbFatigue;
}

export type Phase = "block" | "taper";

// Phase from weeks-to-race. `taper` once fewer than taper_weeks remain; `block`
// (the heavy 12-14 week strength block) otherwise. Undefined when no race is
// known, so the planner keeps its default (non-periodized) behavior.
export function classifyPhase(weeksToRace: number | undefined, config: Config): Phase | undefined {
  if (weeksToRace === undefined) return undefined;
  if (weeksToRace < config.periodization.taper_weeks) return "taper";
  return "block";
}

// Strength sessions/week the phase asks for (before the fatigue cap is applied).
// The final taper week (< taper_zero_weeks) drops strength entirely.
export function phaseWeightSessions(
  phase: Phase | undefined,
  weeksToRace: number | undefined,
  config: Config,
): number {
  if (phase === "taper") {
    if (weeksToRace !== undefined && weeksToRace < config.periodization.taper_zero_weeks) {
      return 0;
    }
    return config.scheduling.weight_sessions_taper;
  }
  return config.scheduling.weight_sessions;
}

function classifyIntensity(fatigue: FatigueLevel): CyclingIntensity {
  if (fatigue === "fresh") return "hard";
  if (fatigue === "fatigued" || fatigue === "very_fatigued") return "easy";
  return "moderate";
}

export function rampGuardTriggered(rampRatePct: number | undefined, config: Config): boolean {
  if (rampRatePct === undefined) return false;
  return rampRatePct > config.scheduling.max_weekly_ramp_pct;
}

function isHard(type: WorkoutType, intensity: CyclingIntensity | "hard"): boolean {
  if (type === "weights" || type === "sweet_spot") return true;
  return intensity === "hard";
}

// What an existing calendar event counts as for placement constraints.
export type ExistingEventKind = "weights" | "sweet_spot" | "hard_cycling" | "easy" | "other";

// Classify an existing calendar event so locked days participate in the
// scheduler's constraints instead of being invisible. Name patterns cover
// planner-written events and hand-added ones; planned IF is the fallback for
// arbitrary names (e.g. a hand-added or third-party workout title).
export function classifyExistingEvent(e: IntervalsEvent): ExistingEventKind {
  if (e.category === "NOTE") return "other"; // rest-day notes carry no training stress
  if (e.category === "HOLIDAY") return "other"; // travel banners carry no training stress, whatever their name says
  if (e.category?.startsWith("RACE")) return "hard_cycling";
  if (e.type === "WeightTraining" || /strength|weights/i.test(e.name)) return "weights";
  if (/sweet ?spot/i.test(e.name)) return "sweet_spot";
  if (/vo2|threshold|interval|over[\s-]?under|anaerobic|sprint/i.test(e.name)) {
    return "hard_cycling";
  }
  if (/easy|endurance|recovery|long|zone ?2|\bz2\b/i.test(e.name)) return "easy";
  if (typeof e.icu_intensity === "number") {
    // Bands mirror classifyByIF/HARD_ZONES in zones.ts: sweet spot is
    // 0.83 < IF <= 0.93; threshold and above is hard; tempo and below is easy.
    if (e.icu_intensity > 0.93) return "hard_cycling";
    if (e.icu_intensity > 0.83) return "sweet_spot";
    return "easy";
  }
  return "other";
}

// The planner only ever fills cycling days as "easy" or "hard" (the ~80/20
// split deliberately avoids "moderate" grey-zone rides), so this handles just
// those two.
function buildCyclingDescription(intensity: "easy" | "hard", targetZone?: Zone): string {
  const zoneSuffix = targetZone ? ` — target zone: ${zoneLabel(targetZone)}` : "";
  switch (intensity) {
    case "easy":
      return "Easy ride — Zone 2 recovery spin";
    case "hard":
      // Prose fallback only — hard cycling days render as a structured
      // interval session (src/workout.ts) whenever a targetZone is set, which
      // is the case on the plan path. This text surfaces just when no zone is
      // available (no distribution supplied), so keep it self-contained.
      return `Hard interval ride${zoneSuffix}`;
  }
}

// Polarized placement: consolidate stress onto "hard days" (sweet-spot +
// hard-cycling target days) so weights stack with them in the same session,
// preserving full-recovery days for easy rides or rest. Within a stacked day,
// the cycling workout precedes the weights session — hard intervals are done
// on fresh legs; weights go last so the aerobic AMPK signal has begun to fade.
//
// Fatigue tiers:
//   - fresh:          hard cycling targets + weights co-locate on both
//   - moderate/fatigued: only sweet-spot is a natural hard day; weights
//                        stack with it and overflow to their own day(s)
//   - very_fatigued:  day 0 reserved for rest; sweet-spot dropped; a single
//                     strength session placed mid-week
export function schedule(input: SchedulerInput): PlannedWorkout[] {
  const {
    startDate,
    existingEvents,
    trainingLoad,
    config,
    zoneDistribution,
    rampRatePct,
    completedDates,
    weeksToRace,
  } = input;
  const days = 7;
  const { scheduling, weight_training, weight_training_taper, sweet_spot } = config;
  const guardOn = rampGuardTriggered(rampRatePct, config);

  // Track zones already assigned to hard rides this week so consecutive hard
  // days target different zones (highest deficit first, then second-highest).
  // Seed with "sweet_spot" so hard-cycling days never target it: the dedicated
  // sweet-spot session (Phase 1) already covers that zone, and without this
  // mostDeficientZone can hand sweet_spot back to Phase 2 — producing a second,
  // structurally identical sweet-spot workout the same week. Hard-cycling days
  // are for the short-interval zones (threshold / VO2 / anaerobic).
  const usedHardZones = new Set<Zone>(["sweet_spot"]);
  const pickHardZone = (): Zone | undefined => {
    if (!zoneDistribution) return undefined;
    // Undefined once every hard zone is used (e.g. a 4th hard-cycling day after
    // threshold/vo2/anaerobic are taken): the day stays an unstructured "Hard
    // Ride" rather than duplicating a session, and never recycles sweet_spot.
    const z = mostDeficientZone(zoneDistribution, undefined, usedHardZones);
    if (z) usedHardZones.add(z);
    return z;
  };

  // Lock days that already have a planned calendar event OR a completed
  // activity — the planner only fills genuinely empty days, so a session
  // already logged today shouldn't get a duplicate piled on top of it.
  // Intervals.icu returns start_date_local with a time component (e.g.
  // "2026-04-21T00:00:00"), so normalize every source to its YYYY-MM-DD prefix
  // before comparing — otherwise occupied days never match and get double-booked.
  const dayKey = (d: string): string => d.slice(0, 10);
  // Holiday days are locked too, so no phase places a workout on them. A
  // HOLIDAY event covered by holidayDates must not itself lock its start day
  // (its span is handled here, and locking would suppress the placeholder
  // below); an uncovered one — caller has holidays disabled — locks its start
  // day exactly as before this feature existed.
  const holidaySet = new Set((input.holidayDates ?? []).map(dayKey));
  const occupiedDates = new Set([
    ...existingEvents
      .filter((e) => !(e.category === "HOLIDAY" && holidaySet.has(dayKey(e.start_date_local))))
      .map((e) => dayKey(e.start_date_local)),
    ...(completedDates ?? []).map(dayKey),
  ]);
  const lockedDates = new Set([...occupiedDates, ...holidaySet]);
  const dates: string[] = [];
  for (let i = 0; i < days; i++) dates.push(addDays(startDate, i));
  const available = dates.map((d, i) => (lockedDates.has(d) ? -1 : i)).filter((i) => i >= 0);

  // Seed constraint state from existing events so locked days aren't invisible
  // to placement: an existing sweet-spot fills this week's quota, existing hard
  // sessions block adjacent hard placement, and existing strength sessions
  // count toward weight_sessions and min_weight_gap_days. Events shortly
  // before the window get a negative index — they participate in adjacency and
  // gap math but not in this week's quotas.
  const existingHardDays = new Set<number>();
  const existingWeightDays: number[] = [];
  let existingSweetSpots = 0;
  let existingHardRides = 0;
  // A long endurance ride already on this week's calendar must suppress the
  // promotion below — otherwise the planner promotes a second easy ride to a
  // long ride and the week ends up with two. classifyExistingEvent folds "long"
  // into the "easy" bucket, so match the name directly here. Word-boundary
  // anchors avoid false positives like "Prolonged Effort" or "Longmont Crit".
  let hasExistingLongRide = false;
  for (const e of existingEvents) {
    if (e.category === "HOLIDAY") continue; // no training stress, and "Long weekend away" must not eat the long-ride promotion
    const idx = dayDiff(startDate, dayKey(e.start_date_local));
    if (idx >= days) continue;
    if (idx >= 0 && /\blong\b/i.test(e.name)) hasExistingLongRide = true;
    const kind = classifyExistingEvent(e);
    if (kind === "easy" || kind === "other") continue;
    existingHardDays.add(idx);
    if (kind === "weights") {
      existingWeightDays.push(idx);
    } else if (idx >= 0) {
      if (kind === "sweet_spot") existingSweetSpots++;
      else existingHardRides++;
    }
  }

  // TSB sets the base tier; suppressed HRV/RHR readiness downgrades it one tier
  // (floored at "fatigued"), the same easy-bias philosophy as the ramp guard.
  const fatigue = effectiveFatigue(classifyFatigue(trainingLoad.tsb, config), input.readiness);
  // When the ramp guard fires, treat the week as moderate at best — drops
  // hard cycling targets entirely and downgrades hard fills to easy. Same
  // philosophy as the TSB-driven downgrade, just driven by CTL ramp.
  const baseIntensity = classifyIntensity(fatigue);
  const intensity: CyclingIntensity =
    guardOn && baseIntensity === "hard" ? "moderate" : baseIntensity;
  const veryFatigued = fatigue === "very_fatigued";
  // Polarized stacking — co-locating weights onto a hard day — only makes sense
  // when there's capacity to absorb a concentrated stress day. On recovery
  // weeks (fatigued or worse) it just piles two hard sessions together and
  // defeats the recovery intent, so weights get their own spaced-out days.
  const stackWeightsOnHardDays = fatigue === "fresh" || fatigue === "moderate";
  const phase = classifyPhase(weeksToRace, config);
  const strengthRoutine =
    phase === "taper" ? (weight_training_taper ?? weight_training) : weight_training;
  // Phase asks for a session count; fatigue can only reduce it, never inflate it.
  const fatigueSessions = veryFatigued
    ? scheduling.weight_sessions_very_fatigued
    : scheduling.weight_sessions;
  const weightSessionsTarget = Math.min(
    phaseWeightSessions(phase, weeksToRace, config),
    fatigueSessions,
  );
  // Strength sessions already on this week's calendar consume the quota;
  // pre-window ones only constrain spacing, not the count.
  const weightSessionsRemaining = Math.max(
    0,
    weightSessionsTarget - existingWeightDays.filter((i) => i >= 0).length,
  );

  // Each day can hold multiple workouts (hard cycling + weights = one stacked
  // training day, two PlannedWorkout entries).
  const plan: PlannedWorkout[][] = Array.from({ length: days }, () => []);
  const isHardDay = (idx: number): boolean =>
    existingHardDays.has(idx) ||
    (idx >= 0 && idx < days && plan[idx].some((w) => isHard(w.type, w.intensity)));
  const isEmpty = (idx: number): boolean => plan[idx].length === 0;
  const wouldCreateBackToBack = (idx: number): boolean => isHardDay(idx - 1) || isHardDay(idx + 1);
  const respectsWeightGap = (idx: number, slots: number[]): boolean =>
    [...slots, ...existingWeightDays].every(
      (s) => Math.abs(idx - s) >= scheduling.min_weight_gap_days,
    );

  // Phase H: holiday days. Locked out of every placement phase (see
  // lockedDates), so nothing below lands on them. In "placeholder" mode each
  // holiday day that isn't already occupied by a real event or a logged
  // activity gets a zero-load optional cross-training entry, so the calendar
  // shows the planner saw the trip rather than silently going blank.
  if (config.holidays.mode === "placeholder") {
    for (let i = 0; i < days; i++) {
      if (!holidaySet.has(dates[i]) || occupiedDates.has(dates[i])) continue;
      plan[i].push(holidayPlaceholderWorkout(dates[i]));
    }
  }

  // Phase 0: when very fatigued, reserve day 0 as rest before any hard placement.
  if (veryFatigued && available.includes(0)) {
    plan[0].push({
      date: dates[0],
      type: "rest",
      name: "Rest Day",
      description: "Priority recovery — starting the week very fatigued",
      intensity: "easy",
    });
  }

  // Phase 1: sweet-spot (mid-week), unless very fatigued or the calendar
  // already holds one this week.
  let lcIdx: number | undefined;
  if (!veryFatigued && existingSweetSpots === 0) {
    const lcCandidates = available.filter((i) => isEmpty(i) && !wouldCreateBackToBack(i));
    lcIdx = lcCandidates.find((i) => i >= 2 && i <= 4) ?? lcCandidates[0];
    if (lcIdx !== undefined) {
      plan[lcIdx].push({
        date: dates[lcIdx],
        type: "sweet_spot",
        name: sweet_spot.name,
        description: sweet_spot.description,
        intensity: "hard",
      });
    }
  }

  // Phase 2: pre-select hard cycling target days (only when fresh enough).
  // These days will get hard cycling AND become co-location sites for weights.
  // We cap at weightSessionsTarget so every target can host a strength session.
  const hardCyclingTargets = new Set<number>();
  if (intensity === "hard") {
    for (const i of available) {
      if (hardCyclingTargets.size + existingHardRides >= scheduling.hard_cycling_days) break;
      if (!isEmpty(i)) continue;
      if (wouldCreateBackToBack(i)) continue;
      // Spacing: hard cycling days follow min_weight_gap_days from each other
      // and from the sweet-spot day, so co-located weights get proper rest.
      const existingHardSpots = [lcIdx, ...hardCyclingTargets].filter(
        (x): x is number => x !== undefined,
      );
      if (!respectsWeightGap(i, existingHardSpots)) continue;
      hardCyclingTargets.add(i);
      const targetZone = pickHardZone();
      plan[i].push({
        date: dates[i],
        type: "cycling",
        name: targetZone ? `${zoneLabel(targetZone)} Intervals` : "Hard Ride",
        description: buildCyclingDescription("hard", targetZone),
        intensity: "hard",
        ...(targetZone ? { targetZone } : {}),
      });
    }
  }

  // Phase 3: place weights, co-locating with hard days first, then overflowing.
  const weightSlots: number[] = [];
  const hardStackOrder = stackWeightsOnHardDays
    ? [
        ...(lcIdx !== undefined ? [lcIdx] : []),
        ...[...hardCyclingTargets].sort((a, b) => a - b),
      ].sort((a, b) => a - b)
    : [];
  for (const i of hardStackOrder) {
    if (weightSlots.length >= weightSessionsRemaining) break;
    if (!respectsWeightGap(i, weightSlots)) continue;
    weightSlots.push(i);
  }

  if (weightSlots.length < weightSessionsRemaining) {
    // Overflow: find additional days for weights. Candidates are empty days
    // (plus hard-cycling target days that weren't picked above, but those are
    // already "full" from our POV). Very_fatigued prefers mid-week.
    const overflowCandidates = available.filter((i) => isEmpty(i) && !weightSlots.includes(i));
    const ordered = veryFatigued
      ? [...overflowCandidates].sort((a, b) => {
          const midA = a >= 2 && a <= 4 ? 0 : 1;
          const midB = b >= 2 && b <= 4 ? 0 : 1;
          return midA - midB || a - b;
        })
      : overflowCandidates;
    for (const i of ordered) {
      if (weightSlots.length >= weightSessionsRemaining) break;
      if (wouldCreateBackToBack(i)) continue;
      if (!respectsWeightGap(i, weightSlots)) continue;
      weightSlots.push(i);
    }
  }

  for (const i of weightSlots) {
    plan[i].push({
      date: dates[i],
      type: "weights",
      name: strengthRoutine.name,
      description: strengthRoutine.description,
      intensity: "hard",
      durationMin: strengthRoutine.duration_minutes,
    });
  }

  // Phase 4: rest day — placed after the hardest cluster. Skipped if day 0
  // rest already exists and no natural "after hard" slot is better; in that
  // case we still try to find a second rest for recovery from the weights.
  const restCandidates = available.filter((i) => isEmpty(i));
  const restIdx =
    restCandidates.find((i) => isHardDay(i - 1)) ?? restCandidates[restCandidates.length - 1];
  if (restIdx !== undefined) {
    plan[restIdx].push({
      date: dates[restIdx],
      type: "rest",
      name: "Rest Day",
      description: "Recovery — no planned workout",
      intensity: "easy",
    });
  }

  // Phase 5: fill every remaining empty day with an easy Zone 2 ride. Hard
  // stress is deliberately concentrated into the sweet-spot session (Phase 1)
  // and the capped hard-cycling target days (Phase 2, ≤ hard_cycling_days);
  // everything else stays easy so the week holds the ~80/20 low-intensity
  // majority. Filling these days "moderate" — the old behavior — is exactly the
  // grey-zone trap the 80/20 / polarized evidence warns against, so we don't.
  for (let i = 0; i < days; i++) {
    if (!isEmpty(i) || lockedDates.has(dates[i])) continue;
    plan[i].push({
      date: dates[i],
      type: "cycling",
      name: "Easy Ride",
      description: buildCyclingDescription("easy"),
      intensity: "easy",
    });
  }

  // Flatten, preserving date order. Within a day, cycling precedes weights:
  // hard intervals go first on fresh legs; weights go after the aerobic
  // AMPK signal has begun to fade.
  const typeRank = (t: WorkoutType): number => {
    if (t === "rest") return 0;
    if (t === "cycling" || t === "sweet_spot") return 1;
    return 2; // weights / travel
  };
  const out: PlannedWorkout[] = [];
  for (let i = 0; i < days; i++) {
    const sorted = [...plan[i]].sort((a, b) => typeRank(a.type) - typeRank(b.type));
    out.push(...sorted);
  }

  attachLoadTargets(out, config, hasExistingLongRide);
  return out;
}

// Attach planned-load targets (TSS / duration / IF) to each generated workout so
// the calendar shows them and Intervals.icu folds them into the planned CTL
// curve. TSS = (minutes / 60) * IF^2 * 100. The latest easy ride of the week is
// promoted to the single long endurance ride (century durability) — a longer
// duration at the same easy IF — unless one is already on the calendar
// (hasExistingLongRide), in which case no new ride is promoted so the week
// keeps exactly one long ride. Weights get a duration only (no TSS/IF), which
// matches how Intervals.icu treats WeightTraining.
function attachLoadTargets(
  out: PlannedWorkout[],
  config: Config,
  hasExistingLongRide = false,
): void {
  const lt = config.load_targets;
  const tss = (min: number, ifv: number): number => Math.round((min / 60) * ifv * ifv * 100);

  // Promote the last easy cycling ride to the weekly long ride, unless the
  // calendar already holds one this week.
  let longIdx = -1;
  if (!hasExistingLongRide) {
    for (let i = 0; i < out.length; i++) {
      if (out[i].type === "cycling" && out[i].intensity === "easy") longIdx = i;
    }
  }

  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    // Travel placeholders keep their fixed duration and stay load-free: a
    // holiday day must not count toward planned CTL.
    if (w.type === "rest" || w.type === "travel") continue;
    if (w.type === "weights") {
      w.durationMin = w.durationMin ?? config.weight_training.duration_minutes;
      continue;
    }
    if (w.type === "sweet_spot") {
      w.durationMin = config.sweet_spot.duration_minutes;
      w.intensityFactor = lt.sweet_spot_if;
      w.load = tss(w.durationMin, lt.sweet_spot_if);
      continue;
    }
    // cycling
    if (w.intensity === "easy") {
      const isLong = i === longIdx;
      w.durationMin = isLong ? lt.long_minutes : lt.easy_minutes;
      w.intensityFactor = lt.easy_if;
      w.load = tss(w.durationMin, lt.easy_if);
      if (isLong) {
        w.name = "Long Endurance Ride";
        w.description = `Weekly long endurance ride — steady Zone 2, ~${(lt.long_minutes / 60).toFixed(1)}h. Practice century fueling (~60-90g carb/hr). The durability anchor of the week.`;
      }
    } else {
      w.durationMin = lt.hard_minutes;
      w.intensityFactor = lt.hard_if;
      w.load = tss(w.durationMin, lt.hard_if);
    }
  }
}
