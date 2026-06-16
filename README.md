# workout-planner

Weekly training planner for cyclists. Reads current form (CTL/ATL/TSB) from
Intervals.icu and training recommendations from Xert, schedules a 7-day plan of
cycling, sweet-spot intervals, weight training, and recovery, then
pushes the plan as events to the Intervals.icu calendar.

## Install

```sh
npm ci
cp .env.example .env   # then fill in credentials
```

Requires Node.js 20+.

## Configure

Credentials live in `.env`:

| Variable            | What it is                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `INTERVALS_API_KEY` | Intervals.icu API key (Settings → API)                                  |
| `XERT_USERNAME`     | Xert account email                                                      |
| `XERT_PASSWORD`     | Xert account password (OAuth password grant)                            |
| `HEVY_API_KEY`      | Hevy Pro API key, for strength logging (Settings → Developer); optional |

Workout definitions and scheduling rules live in `config.yaml`:

- `weight_training` — name, duration, and description pushed on weight days.
- `sweet_spot` — name, duration, and description pushed on the weekly quality (sweet-spot) day.
- `scheduling.tsb_fresh` — TSB above this is considered "fresh" (default `5`).
- `scheduling.tsb_fatigued` — TSB below this is considered "fatigued" (default `-10`).
- `scheduling.weight_sessions` — weight sessions per week (default `2`).
- `scheduling.min_weight_gap_days` — minimum days between weight sessions (default `2`).
- `scheduling.max_weekly_ramp_pct` — CTL ramp above this triggers an easy-bias
  guard (default `7`).
- `scheduling.hard_cycling_days` — max hard interval rides per week, on top of
  the sweet-spot day (default `1`). This is the 80/20 cap: every non-quality day
  fills as easy Zone 2, never "moderate". Raise to `2` only for a dedicated
  build block.
- `load_targets` — planned TSS/duration/IF the planner attaches to each
  generated workout (so the calendar shows targets and Intervals.icu folds them
  into planned CTL). TSS = `(minutes / 60) * IF^2 * 100`. The latest easy ride
  each week is auto-promoted to a single long endurance ride (`long_minutes`),
  the century durability anchor. Keys: `easy_if`, `easy_minutes`, `long_minutes`,
  `hard_if`, `hard_minutes`, `sweet_spot_if`.

## Commands

```sh
npm run check                     # smoke-test Intervals.icu + Xert credentials
npm run status                    # show current CTL/ATL/TSB and Xert metrics
npm run status -- --json          # same data as JSON, including zone mix and ramp
npm run plan -- --dry-run         # print the week's plan without pushing
npm run plan                      # generate and push the plan to Intervals.icu
```

The `plan` command fetches existing Intervals.icu events for the next 7 days
and leaves those dates untouched; only empty days are filled. It also locks any
day that already has a **completed activity** (e.g. a ride you logged today), so
it never schedules on top of a session you've already done.

### Hand-tuned weeks

When the generated plan isn't quite what you want, edit `scripts/week-plan.yaml`
and push it directly:

```sh
npm run push-week -- --dry-run               # preview, write nothing
npm run push-week                            # push scripts/week-plan.yaml
npm run push-week -- --start 2026-06-08      # anchor to a specific Monday
npm run push-week -- --file other-plan.yaml  # use a different plan file
npm run events                               # list calendar events (next 7 days)
npm run events -- 2026-06-08 2026-06-14      # …for an explicit date range
```

The plan file anchors to the upcoming Monday by default; each session names a
`day` plus either a `workout:` (pulled from `config.yaml`) or an explicit
`name`/`type`/`description`. Days that already hold an event are skipped, so
re-running never duplicates.

### Strength logging

Intervals.icu has no structured per-set fields, so strength lift detail
(exercises, sets, reps, weights/bands, RPE) is written into the **description**
of the Companion-synced `WeightTraining` activity. Two importers normalize their
input through `src/strength.ts` so they produce byte-identical descriptions; the
description begins with a marker line that makes re-runs idempotent (a re-run
overwrites its own output but leaves hand-written descriptions alone unless
`--force`d).

```sh
npm run push-strength:hevy                  # dry run, recent Hevy workouts
npm run push-strength:hevy -- --apply       # write descriptions
npm run push-strength:hevy -- --since 2026-06-01
npm run push-strength                        # Strong CSV importer (historical backfill)
```

`push-strength:hevy` pulls live from the Hevy API (needs `HEVY_API_KEY`) and
matches workouts to activities by **UTC start time** within a tolerance window,
so there's no timezone guesswork and no manual export. `push-strength` reads a
Strong CSV export and matches by start timestamp — used for one-off backfill.

## How the schedule is built

For each 7-day window, starting from today:

1. **Place one sweet-spot session** mid-week when possible, avoiding
   back-to-back hard days.
2. **Place two weight sessions** with at least `min_weight_gap_days` between
   them, again avoiding back-to-back hard days.
3. **Place one rest day**, preferring the day after a hard cluster.
4. **Fill remaining days with easy Zone 2 rides.** Hard stress is deliberately
   concentrated into the sweet-spot session plus up to `hard_cycling_days` hard
   interval rides (placed only when TSB is fresh and the ramp guard is off);
   every other day fills as easy Zone 2. This holds the ~80/20 low-intensity
   majority the training-science evidence calls for — the planner never
   schedules "moderate" grey-zone fills. See `docs/cycling-training-report.md`.

Weight and sweet-spot days are always classified as "hard" for the
back-to-back constraint.

On **fresh** or **moderate** weeks, weight sessions are co-located onto hard
days (polarized stacking) to keep full-recovery days open. On **fatigued** or
**very fatigued** weeks this is disabled — stacking two hard sessions on one day
defeats the recovery intent — so weights get their own spaced-out days instead.

### Zone targeting

Each hard cycling day is tagged with a target power zone — sweet spot,
threshold, VO2, or anaerobic — chosen to fill the largest gap between the
last 28 days of TSS-weighted zone distribution and a hardcoded baseline.
Two hard rides in a week are guaranteed to target different zones.

### Structured workouts (target power & heart rate)

Rides with a deterministic structure are pushed as **Intervals.icu plain-text
workouts** rather than prose, so Intervals.icu renders per-interval targets and
shows them in the calendar and the Companion app:

- **Sweet-spot sessions** are written as power steps (`88-94%`), so Intervals.icu
  computes **target watts** from your stored FTP.
- **Easy and long endurance rides** are written as a heart-rate step (`Z2 HR`),
  so Intervals.icu computes the **target bpm** band from your stored HR zones.

A step targets one primary metric, so quality work is paced by power and the
aerobic base by heart rate — each derived from your own stored zones. Hard Xert
workout-of-the-day rides (no fixed structure) and weight sessions (no power/HR
model) keep their prose descriptions. The full coaching rationale for the
sweet-spot session lives in `config.yaml` and `docs/`; the calendar event
carries the executable structure plus short per-step labels. The builder lives
in `src/workout.ts`.

### Ramp guard

If the trailing 7-day CTL ramp exceeds `max_weekly_ramp_pct`, hard cycling
targets are dropped and remaining hard fills are downgraded — the same
philosophy as the TSB-driven downgrade, just driven by CTL ramp rate. The
`plan` output prints a warning when this fires.

## Development

```sh
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format      # prettier --write
```

CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, and tests
on push and PR to `main`.

## Docs

- [`docs/cycling-training-report.md`](docs/cycling-training-report.md) — the
  training-science rationale behind the planner's 80/20 polarization, zone
  targeting, and strength prescription, with citations.
