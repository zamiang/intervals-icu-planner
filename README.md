# intervals-icu-planner

Weekly training planner for [Intervals.icu](https://intervals.icu): 80/20
cycling + heavy strength, driven by your CTL/TSB, eFTP, and HRV readiness.

It reads your current form (CTL/ATL/TSB), zone distribution, FTP, and
HRV/resting-HR readiness from Intervals.icu, schedules a 7-day plan of easy
Zone 2 riding, sweet-spot intervals, weight training, and recovery, then pushes
the plan to your Intervals.icu calendar as structured workouts with power and
HR targets. Strength sessions logged in [Hevy](https://www.hevyapp.com) sync
back into the matching activities as set-by-set detail.

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
- `periodization` — race-taper behavior. Within `taper_weeks` of your race
  (the earliest upcoming `RACE_A` event on your Intervals.icu calendar, or the
  `race_date` fallback), strength drops to one shorter taper session per week
  (`weight_training_taper`); in the final `taper_zero_weeks` week(s) strength
  is skipped entirely. With no race set, no taper logic applies.
- `load_targets` — planned TSS/duration/IF the planner attaches to each
  generated workout (so the calendar shows targets and Intervals.icu folds them
  into planned CTL). TSS = `(minutes / 60) * IF^2 * 100`. The latest easy ride
  each week is auto-promoted to a single long endurance ride (`long_minutes`),
  the century durability anchor. Keys: `easy_if`, `easy_minutes`, `long_minutes`,
  `hard_if`, `hard_minutes`, `sweet_spot_if`.

## Commands

```sh
npm run check                     # smoke-test Intervals.icu credentials
npm run status                    # show current CTL/ATL/TSB, FTP/eFTP, and readiness
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
npm run push-strength:hevy -- --apply --create-missing  # create unmatched activities
npm run push-strength                        # Strong CSV importer (historical backfill)
```

`push-strength:hevy` pulls live from the Hevy API (needs `HEVY_API_KEY`) and
matches workouts to activities by **UTC start time** within a tolerance window,
so there's no timezone guesswork and no manual export. `push-strength` reads a
Strong CSV export and matches by start timestamp — used for one-off backfill.

With `--create-missing`, a Hevy workout that matches no existing
`WeightTraining` activity (e.g. the session was never recorded on the watch,
so the Companion sync created nothing) is pushed as a new **manual activity**
with Hevy's start time and duration, instead of being reported as unmatched.
This makes Hevy the source of truth for strength sessions: don't combine it
with watch recordings of the same lift, or the created activity will duplicate
the Companion-synced one.

## Weekly automation (GitHub Actions)

`.github/workflows/weekly-plan.yml` runs every **Monday at 10:00 UTC**
(6 AM Eastern) and does two things:

1. `npm run plan` — generates the week and pushes it to the Intervals.icu
   calendar. Days that already hold events or completed activities are
   skipped, so a hand-tuned week pushed via `push-week` beforehand wins and
   the action only fills what's empty.
2. `npm run push-strength:hevy -- --create-missing --apply` — writes recent
   Hevy lift detail into the matching Intervals.icu strength activities,
   creating the activity first when no watch recording produced one.

It needs two repository secrets (Settings → Secrets and variables → Actions),
mirroring `.env`: `INTERVALS_API_KEY` and `HEVY_API_KEY`.

Run it on demand from the Actions tab (`workflow_dispatch`), optionally with
**dry run** checked to preview without writing. To hand-tune a week instead,
edit `scripts/week-plan.yaml` and `npm run push-week` before Monday morning —
the action will leave those days alone. GitHub pauses cron schedules after
~60 days without repo activity; re-enable from the Actions tab if that
happens.

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
   schedules "moderate" grey-zone fills.

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
- **Hard interval rides** are built from the day's target zone (see [Zone
  targeting](#zone-targeting)) as power steps off your stored FTP — a
  self-constructed session per zone, no external workout-of-the-day:
  - **VO2 Max** — 5×3 min @ 110–118% FTP
  - **Threshold** — 4×8 min @ 95–102% FTP
  - **Anaerobic** — 8×1 min @ 125–140% FTP

  each with an easy warm-up (plus threshold openers) and cool-down. The event is
  named for its zone (e.g. "VO2 Max Intervals").

- **Easy and long endurance rides** are written with both a power target and an
  HR-zone target (`62% Z2 HR`): the **HR zone** shows the target bpm band from
  your stored HR zones, while the **power target** (set to the planned IF) is
  what Intervals.icu uses to compute planned load. An HR-only step leaves
  `normalized_power` at 0, so Intervals.icu can't forecast TSS/CTL and falls
  back to a broken ~33% estimate — the explicit power target avoids that.

Quality work is paced by power and the aerobic base by heart rate — each
derived from your own stored zones. Weight sessions (no power/HR model) keep
their prose descriptions. The full coaching rationale for the sweet-spot session
lives in `config.yaml`; each calendar event carries the executable
structure plus short per-step labels. The builder lives in `src/workout.ts`.

### FTP auto-sync (eFTP)

`plan` and `push-week` read Intervals.icu's rolling **eFTP** estimate (the
`icu_rolling_ftp` stamped on the latest ride) and write it to the Ride
sport-settings FTP, so both the `% FTP` structured steps and the prose watt
callouts track current fitness with no hand edits after each test. A single
jump bigger than `ftp_sync.max_change_pct` is refused as bad data — apply it
manually in Intervals.icu if it's real. `--dry-run` previews the update
without writing; disable entirely with `ftp_sync.enabled: false`.

Prose descriptions in `config.yaml` and `scripts/week-plan.yaml` never
hardcode watts: they carry placeholders rendered at push time from the synced
sport settings — `{ftp}`, `{lthr}`, `{w:88-94}` (watts at % FTP), `{hr:83}`
(bpm at % LTHR). A placeholder that can't be resolved fails the push loudly
rather than putting stale or literal-brace text on the calendar. The sync and
renderer live in `src/ftp.ts`.

### Ramp guard

If the trailing 7-day CTL ramp exceeds `max_weekly_ramp_pct`, hard cycling
targets are dropped and remaining hard fills are downgraded — the same
philosophy as the TSB-driven downgrade, just driven by CTL ramp rate. The
`plan` output prints a warning when this fires.

### Readiness downgrade (HRV & resting HR)

On top of TSB, the planner reads your **HRV and resting heart rate** trend from
Intervals.icu wellness and, when they signal you're under-recovered, downgrades
the week one fatigue tier (floored at "fatigued"). It compares a short recent
window against a personal baseline and fires only on a clear drop:

- recent HRV ≤ baseline mean − `readiness.hrv_drop_sd` standard deviations, or
- recent resting HR ≥ baseline median + `readiness.rhr_rise_bpm` bpm.

Like the ramp guard, it can only ever make the week **easier**, never harder —
good HRV never adds intensity. It's tuned in the `readiness:` block of
`config.yaml` (windows, thresholds, and an artifact guard that discards an
implausibly high resting-HR reading before it can fake an alarm). Set
`readiness.enabled: false` to plan on TSB alone. `npm run status` shows the
current readiness state; a suppressed week is called out in the `plan` output.

#### What Intervals.icu needs for readiness to work

The planner reads two **daily wellness** fields from Intervals.icu:

| Wellness field | What it is               | Drives                      |
| -------------- | ------------------------ | --------------------------- |
| `hrvSDNN`      | morning HRV (SDNN, ms)   | HRV-drop suppression        |
| `restingHR`    | resting heart rate (bpm) | resting-HR-rise suppression |

These are populated automatically when you connect a device/app that records a
**morning HRV + resting-HR measurement** to Intervals.icu (Settings → your
wellness/health-data connections). Any source Intervals.icu syncs wellness from
works — e.g. **Oura, WHOOP, Garmin, Apple Health, Ultrahuman, Polar**, or a
dedicated HRV app like **HRV4Training** or **EliteHRV**. You can also enter the
two values by hand on the Intervals.icu wellness page. Recommendations:

- **Measure consistently** — same time each morning (on waking), same method.
  A device that captures overnight/on-wake HRV automatically (Oura, WHOOP,
  Garmin, Ultrahuman) is the least-effort way to keep the stream unbroken.
- **Build a baseline first** — readiness abstains ("n/a") until it has at least
  `readiness.min_baseline_samples` readings (default **14**) in the
  `readiness.baseline_days` window (default **28**), plus ≥2 in the recent
  `readiness.recent_days` window (default **4**). Expect ~2–4 weeks of daily
  readings before it starts acting.
- **Keep `restingHR` clean** — let the wellness value come from your
  morning/overnight measurement, not from a ride file. Intervals.icu can
  overwrite a day's resting HR with a per-activity estimate; the artifact guard
  (`readiness.rhr_artifact_bpm`) drops readings implausibly far above baseline,
  but a consistent morning source avoids the problem entirely.

If neither field has enough history, readiness simply abstains and the planner
runs on TSB and CTL ramp as usual.

## Development

```sh
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format      # prettier --write
```

CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, and tests
on push and PR to `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full
contribution workflow.

## Disclaimer

This is a training-planning tool, not medical or coaching advice. The
scheduling rules encode published training-science findings (80/20 intensity
distribution, heavy strength work for cyclists, readiness-based load
management), but you know your body and history — adjust the config to suit,
and consult a professional where appropriate.

## License

[MIT](LICENSE)
