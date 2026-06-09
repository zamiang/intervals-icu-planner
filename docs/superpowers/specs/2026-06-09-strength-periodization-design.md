# Strength Periodization — Design

**Date:** 2026-06-09
**Status:** Approved (pending spec review)

## Problem

The planner pushes a single static `weight_training` block on every weight day,
regardless of where the athlete is in their season. Strength needs change as an
A race approaches: build max strength early, shift to maintenance mid-season,
then taper to stay fresh. Today there is no concept of training phase.

## Goal

Vary **both** the strength session count and the routine content pushed to
Intervals.icu based on **weeks remaining until the A race**, derived from the
`RACE_A` event already on the Intervals.icu calendar.

Non-goals: changing cycling prescription logic, periodizing low-cadence work,
or any UI. The existing TSB/fatigue and ramp-guard logic stays authoritative and
layers on top of phase selection.

## Phase Model

Phase is a pure function of weeks-to-race. Boundaries are configurable.

Boundaries are half-open so each week-count maps to exactly one phase
(`base_weeks = 12`, `taper_weeks = 4`, `taper_zero_weeks = 1`):

| Phase  | Weeks to race (wtr)        | Sessions/wk         | Routine            |
| ------ | -------------------------- | ------------------- | ------------------ |
| `base` | `wtr ≥ 12`                 | `weight_sessions`   | max-strength       |
| `build`| `4 ≤ wtr < 12`             | `weight_sessions`   | maintenance        |
| `race` | `1 ≤ wtr < 4`              | `weight_sessions_taper` (1) | taper      |
| `race` (final) | `wtr < 1`          | 0                   | — (none)           |
| none   | no race found              | `weight_sessions`   | max-strength (default) |

When no `RACE_A` event exists and no `race_date` fallback is configured, the
planner behaves exactly as it does today (default routine + `weight_sessions`).
This preserves backward compatibility.

## Architecture

The scheduler stays pure (no I/O). Race-date resolution and weeks-to-race math
happen in the CLI/push layer, which already talks to Intervals.icu.

### Data flow

```
CLI (cli.ts / push-week.ts)
  ├─ getEvents(window covering today..race)         [existing IntervalsClient]
  ├─ find RACE_A event → race date
  │     └─ fallback: config.periodization.race_date
  ├─ compute weeksToRace = ceil((raceDate - startDate) / 7)   [undefined if none]
  └─ schedule({ ...input, weeksToRace })
        └─ classifyPhase(weeksToRace, config) → phase
              ├─ pick routine def  (base|build|race → which WorkoutDefinition)
              └─ pick session count (min(phaseTarget, fatigueTarget))
```

### Components

1. **`classifyPhase(weeksToRace, config): Phase | undefined`** — new pure
   function in `scheduler.ts`. `Phase = "base" | "build" | "race"`. Returns
   `undefined` when `weeksToRace` is undefined.

2. **`resolveRaceDate(events, config): string | undefined`** — new helper
   (CLI-side or `intervals.ts`). Returns the earliest future `RACE_A` event date,
   else `config.periodization.race_date`, else undefined.

3. **`schedule()`** — gains `weeksToRace?: number` on `SchedulerInput`. Uses
   `classifyPhase` to select the routine `WorkoutDefinition` and the phase
   session-count target. Effective count = `min(phaseTarget, fatigueTarget)` so
   fatigue can still reduce but never inflate volume. `race`-final (< taper_zero)
   yields 0 sessions.

4. **Config** — new optional fields (all defaulted for backward compat):
   ```yaml
   weight_training:            # existing — serves as the `base` (max-strength) routine
   weight_training_maintenance:  # optional; falls back to weight_training
   weight_training_taper:        # optional; falls back to weight_training_maintenance, then weight_training
   periodization:
     base_weeks: 12       # ≥ this many weeks → base
     taper_weeks: 4       # < this many weeks → race/taper
     taper_zero_weeks: 1  # < this many weeks → no strength
     race_date: null      # optional ISO date fallback when no RACE_A on calendar
   scheduling:
     weight_sessions_taper: 1   # sessions/wk during taper
   ```

## Routine Variants

All three authored from the heavy block already in `config.yaml`:

- **`weight_training` (max-strength / base):** the current heavy routine as-is.
- **`weight_training_maintenance` (build):** same big compound lifts
  (squat, deadlift, Bulgarian split squat) at heavy load but trimmed — drop the
  upper-body accessory block to 1–2 movements and reduce core volume. Goal:
  retain strength with less fatigue while bike load climbs.
- **`weight_training_taper`:** only the two primary compound lifts (squat +
  deadlift) at heavy load, low volume (2–3 sets), no accessories. Goal: retain
  neuromuscular strength with minimal fatigue cost.

## Error Handling

- No `RACE_A` and no `race_date` → `weeksToRace` undefined → default behavior.
- Race date in the past → treated as no race (undefined phase).
- Multiple `RACE_A` events → use the earliest future one.
- Missing optional routine variant → fall back per the chain above.

## Testing

`test/scheduler.test.ts` (extend) and config tests:

- `classifyPhase`: boundary cases at 12, 4, 1 weeks; undefined input.
- Session-count selection: phase target vs fatigue target `min` interaction
  (e.g. taper + fresh → 1; base + very_fatigued → 1).
- `race`-final week → 0 weight sessions placed.
- Routine selection picks the right `WorkoutDefinition` per phase, with fallback
  when a variant is absent.
- `resolveRaceDate`: RACE_A present, absent-with-config-fallback, past-date,
  multiple events.
- Backward compat: no race info → identical plan to current behavior.

## Out of Scope

- Inferring phase from CTL trend (rejected: can't distinguish base from build).
- Periodizing cycling or low-cadence prescriptions.
- Auto-creating the RACE_A event (done manually / separately).
