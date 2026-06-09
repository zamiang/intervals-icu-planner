# Strength Periodization — Design

**Date:** 2026-06-09
**Status:** Approved (pending spec review)

## Problem

The planner pushes a single static `weight_training` block on every weight day,
regardless of where the athlete is in their season. The evidence
(`cycling-training-report.md` §2) prescribes a **12–14 week heavy strength block
at 2×/week**, then **tapering frequency (not abandoning it)** as event-specific
volume rises near the A race. Today there is no concept of training phase, so the
plan cannot run that block-then-taper structure automatically.

## Goal

Vary the strength session **count** and **routine** pushed to Intervals.icu based
on **weeks remaining until the A race**, derived from the `RACE_A` event already
on the Intervals.icu calendar (Escape New York, 2026-09-26).

Non-goals: changing cycling prescription logic, periodizing the sweet-spot
session, or any UI. The existing TSB/fatigue, ramp-guard, and 80/20 load-target
logic (added in #14) stays authoritative and layers on top of phase selection.

## Phase Model

Two phases, derived from the evidence: keep the heavy block running the full
~12–14 weeks, then taper *frequency* (2×→1×→0) in the final weeks. There is
deliberately **no mid-block "maintenance" routine** — the report says keep it
heavy throughout; acute fatigue is already handled by the TSB/ramp-guard logic.

Phase is a pure function of weeks-to-race. Boundaries are half-open so each
week-count maps to exactly one phase (`taper_weeks = 4`, `taper_zero_weeks = 1`):

| Phase   | Weeks to race (wtr) | Sessions/wk                 | Routine                       |
| ------- | ------------------- | --------------------------- | ----------------------------- |
| `block` | `wtr ≥ 4`           | `weight_sessions` (2)       | `weight_training` (heavy)     |
| `taper` | `1 ≤ wtr < 4`       | `weight_sessions_taper` (1) | `weight_training_taper`       |
| `taper` (final) | `wtr < 1`   | 0                           | — (none)                      |
| none    | no race found       | `weight_sessions` (2)       | `weight_training` (default)   |

When no `RACE_A` event exists and no `race_date` fallback is configured, the
planner behaves exactly as it does today (default routine + `weight_sessions`).
This preserves backward compatibility.

## Architecture

The scheduler stays pure (no I/O). Race-date resolution and weeks-to-race math
happen in the CLI/push layer, which already talks to Intervals.icu.

### Data flow

```
CLI (cli.ts)
  ├─ getEvents(today, raceHorizon)   ← NOTE: separate wide-window fetch.
  │     The existing getEvents(today, endStr) covers only the 7-day plan window
  │     and will NOT see a race 15 weeks out. Fetch a wide window (e.g. +52 wks)
  │     to locate the RACE_A event.
  ├─ resolveRaceDate(events, config) → earliest future RACE_A date, else
  │     config.periodization.race_date, else undefined
  ├─ weeksToRace = raceDate ? ceil((raceDate - today) / 7 days) : undefined
  └─ schedule({ ...input, weeksToRace })
        └─ classifyPhase(weeksToRace, config) → "block" | "taper" | undefined
              ├─ pick routine WorkoutDefinition (block→weight_training,
              │     taper→weight_training_taper, undefined→weight_training)
              └─ pick session count (see below)
```

### Components

1. **`classifyPhase(weeksToRace, config): Phase | undefined`** — new pure
   function in `scheduler.ts`. `Phase = "block" | "taper"`. Returns `undefined`
   when `weeksToRace` is undefined. `taper` when `wtr < taper_weeks`; `block`
   otherwise. (The 0-session final week is handled by the count rule, not a
   separate phase.)

2. **`phaseWeightSessions(phase, weeksToRace, config): number`** — new helper.
   `block` → `weight_sessions`; `taper` with `wtr ≥ taper_zero_weeks` →
   `weight_sessions_taper`; `taper` with `wtr < taper_zero_weeks` → 0; undefined
   phase → `weight_sessions`.

3. **`resolveRaceDate(events, config): string | undefined`** — new helper
   (CLI-side). Earliest future `RACE_A` event date, else
   `config.periodization.race_date`, else undefined.

4. **`schedule()`** — gains `weeksToRace?: number` on `SchedulerInput`.
   - Replaces the current `weightSessionsTarget` derivation. New effective count
     = `min(phaseCount, fatigueCount)` where `fatigueCount` is today's logic
     (`very_fatigued ? weight_sessions_very_fatigued : weight_sessions`). So
     fatigue can still cut volume but phase never inflates it past the fatigue
     cap, and taper/race-week reductions still apply.
   - Selects the routine `WorkoutDefinition` by phase and uses its `name` /
     `description` when placing the `weights` PlannedWorkout (Phase 3 loop).

5. **`attachLoadTargets()` fix** — currently hardcodes
   `config.weight_training.duration_minutes` for the weights duration. With a
   taper routine of different duration this is wrong. Fix: carry the selected
   routine's `duration_minutes` onto the `weights` PlannedWorkout at creation
   time (set `durationMin` in the Phase 3 loop), and have `attachLoadTargets`
   use the already-set `durationMin` for weights instead of re-reading config.

6. **Config** — new optional fields (all defaulted for backward compat),
   following the existing `validateWorkout` / defaults pattern in `config.ts`:
   ```yaml
   weight_training:          # existing — the heavy block routine (unchanged)
   weight_training_taper:    # optional; falls back to weight_training
   periodization:
     taper_weeks: 4          # < this many weeks to race → taper
     taper_zero_weeks: 1     # < this many weeks → no strength
     race_date: null         # optional ISO date fallback when no RACE_A on calendar
   scheduling:
     weight_sessions_taper: 1   # sessions/wk during taper
   ```
   `Config` type gains optional `weight_training_taper?: WorkoutDefinition` and a
   `periodization` block; `SchedulingConfig` gains `weight_sessions_taper`.
   `loadConfig` validates `weight_training_taper` only if present (new optional
   variant of `validateWorkout`).

## Routine Variants

Two routines, both heavy (no light/maintenance variant):

- **`weight_training` (block):** the current heavy routine, unchanged — squat,
  deadlift, Bulgarian split squat heavy, plus accessory/core. Runs the full block.
- **`weight_training_taper`:** the two primary compound lifts (squat + deadlift)
  at the same heavy load but reduced volume (2–3 sets, drop accessories). Goal:
  retain neuromuscular strength with minimal fatigue cost in race-approach weeks.
  Shorter `duration_minutes` than the block routine.

## Error Handling

- No `RACE_A` and no `race_date` → `weeksToRace` undefined → default behavior.
- Race date in the past → treated as no race (undefined phase).
- Multiple `RACE_A` events → use the earliest future one.
- Missing `weight_training_taper` → fall back to `weight_training`.

## Testing

`test/scheduler.test.ts` and `test/config.test.ts` (extend):

- `classifyPhase`: boundaries at `taper_weeks` (4) and `taper_zero_weeks` (1),
  and `undefined` input.
- `phaseWeightSessions`: block→2, taper→1, final-week→0, undefined→2.
- Effective-count `min(phase, fatigue)` interaction: taper + fresh → 1;
  block + very_fatigued → `weight_sessions_very_fatigued`.
- Final taper week → 0 `weights` entries placed.
- Routine selection: `block` uses `weight_training`, `taper` uses
  `weight_training_taper`, with fallback when the taper variant is absent.
- `attachLoadTargets`: a placed taper-routine weights entry carries the taper
  routine's `durationMin`, not the block routine's.
- `resolveRaceDate`: RACE_A present, absent-with-config-fallback, past-date,
  multiple events.
- Backward compat: no race info → plan identical to current behavior.

## Out of Scope

- Inferring phase from CTL trend (rejected: can't distinguish phases reliably).
- A mid-block "maintenance" routine (rejected: evidence says keep it heavy).
- Periodizing cycling or sweet-spot prescriptions.
- Auto-creating the RACE_A event (done manually / already on the calendar).
