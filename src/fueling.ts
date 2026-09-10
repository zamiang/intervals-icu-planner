import type { FuelingConfig, IntervalsEvent, PlannedWorkout } from "./types.js";

// Daily fuelling targets: "what should I eat today", derived from the day the
// scheduler actually planned rather than a fixed weekday table. A 3-hour
// endurance Saturday and a rest Monday get different numbers automatically, so
// the prescription can never drift out of sync with the plan.
//
// The model is deliberately a periodized deficit, not a flat one: the whole
// week averages to `daily_deficit_kcal` below maintenance, but the deficit is
// taken on rest and easy days while hard and long days are fuelled at or near
// maintenance. A flat deficit at this training volume pushes energy
// availability under the ~30 kcal/kg FFM line every day; periodizing keeps the
// weekly average intact without any single day sitting deeply under-fuelled.
//
// Every number here is an estimate with real error bars — resting metabolic
// rate from a prediction equation, ride energy from planned (not executed)
// power. It is a starting point to calibrate against the scale trend, not a
// measurement. See notes/2026-09-07-diet-block.md for the reasoning and the
// biweekly adjustment rule that corrects it.

export interface FuelDayInput {
  date: string; // YYYY-MM-DD
  workouts: PlannedWorkout[]; // every session planned for the day
  weightKg: number;
  heightCm: number;
  ageYears: number;
  ftp: number;
}

export interface CarbRate {
  loGPerHour: number;
  hiGPerHour: number;
}

export interface FuelTargets {
  date: string;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  exerciseKcal: number; // planned training energy folded into kcal
  maintenanceKcal: number; // what the same day would be at zero deficit
  onBikeCarb: CarbRate | null; // null when nothing is ridden, or the ride is a deliberate low-carb day
  rideMinutes: number;
  isFuelDay: boolean; // true when the day is fuelled at/near maintenance
}

// Mifflin-St Jeor resting metabolic rate (male). Chosen over Harris-Benedict
// because it is the better-validated predictor in non-obese adults; it still
// carries roughly +/-10% individual error, which is why the scale trend — not
// this number — is the feedback signal that actually governs the block.
export function restingMetabolicRate(weightKg: number, heightCm: number, ageYears: number): number {
  return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + 5;
}

// Planned energy cost of one session.
//
// Rides: mechanical work in kJ is estimated from the planned IF, and kJ is
// taken as kcal one-for-one — the standard shortcut, since human gross
// efficiency of ~24% almost exactly cancels the kJ->kcal conversion. Planned IF
// describes normalized power, so it is scaled by `avg_power_factor` to recover
// average power, which is what actually determines total work.
//
// Non-ride sessions have no power model, so they use a flat hourly rate.
export function sessionKcal(w: PlannedWorkout, ftp: number, cfg: FuelingConfig): number {
  const minutes = w.durationMin;
  if (typeof minutes !== "number" || minutes <= 0) return 0;
  const hours = minutes / 60;
  if (w.type === "weights") return Math.round(cfg.weights_kcal_per_hour * hours);
  if (w.type === "rest" || w.type === "travel") return 0;
  const intensityFactor = w.intensityFactor;
  if (typeof intensityFactor !== "number" || intensityFactor <= 0) return 0;
  const avgWatts = intensityFactor * ftp * cfg.avg_power_factor;
  return Math.round((avgWatts * minutes * 60) / 1000);
}

// On-bike carbohydrate rate for the day's riding.
//
// Precedence matters. A long ride is fuelled fully even when it is easy —
// duration, not intensity, is what empties glycogen. A short quality session is
// fuelled because carbohydrate availability is what determines interval
// quality. What is left — short easy riding — is the one place a deficit can be
// taken without touching training quality, so it returns null (ride it low-carb
// rather than topping up).
export function carbRate(
  rideMinutes: number,
  hardestIf: number | null,
  cfg: FuelingConfig,
): CarbRate | null {
  if (rideMinutes <= 0) return null;
  const band = (r: [number, number]): CarbRate => ({ loGPerHour: r[0], hiGPerHour: r[1] });
  if (rideMinutes >= cfg.long_min_minutes) return band(cfg.long_carb_g_per_hour);
  if (hardestIf !== null && hardestIf >= cfg.hard_min_if) return band(cfg.hard_carb_g_per_hour);
  if (rideMinutes <= cfg.low_carb_max_minutes) return null;
  return band(cfg.moderate_carb_g_per_hour);
}

// A day counts as a fuel day when it carries a genuine training stimulus worth
// protecting: a long ride, or any quality session. Those days are pulled back
// toward maintenance and the rest of the week absorbs the deficit.
function isFuelDay(rideMinutes: number, hardestIf: number | null, cfg: FuelingConfig): boolean {
  if (rideMinutes >= cfg.long_min_minutes) return true;
  return hardestIf !== null && hardestIf >= cfg.hard_min_if;
}

export function fuelTargetsFor(input: FuelDayInput, cfg: FuelingConfig): FuelTargets {
  const { date, workouts, weightKg, heightCm, ageYears, ftp } = input;

  const rides = workouts.filter((w) => w.type === "cycling" || w.type === "sweet_spot");
  const rideMinutes = rides.reduce((sum, w) => sum + (w.durationMin ?? 0), 0);
  const ifs = rides
    .map((w) => w.intensityFactor)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const hardestIf = ifs.length > 0 ? Math.max(...ifs) : null;

  const exerciseKcal = workouts.reduce((sum, w) => sum + sessionKcal(w, ftp, cfg), 0);
  const baseKcal = restingMetabolicRate(weightKg, heightCm, ageYears) * cfg.non_exercise_multiplier;
  const maintenanceKcal = Math.round(baseKcal + exerciseKcal);

  // Periodized deficit: the weekly average is `daily_deficit_kcal`, but fuel
  // days give back `fuel_day_addback_kcal` of it and the remaining days carry
  // correspondingly more. The add-back is a fixed shift rather than a
  // proportional one so a rest day never collapses toward nothing.
  const fuelDay = isFuelDay(rideMinutes, hardestIf, cfg);
  const deficit = fuelDay
    ? Math.max(0, cfg.daily_deficit_kcal - cfg.fuel_day_addback_kcal)
    : cfg.daily_deficit_kcal + cfg.deficit_day_extra_kcal;

  // Never prescribe below the floor, whatever the arithmetic says. A day under
  // this is not a smaller deficit, it is under-eating.
  const kcal = Math.max(cfg.min_kcal, Math.round(maintenanceKcal - deficit));

  // Protein and fat are set first and held constant across the week — protein
  // because it is what preserves lean mass in a deficit, fat because of the
  // hormonal floor. Carbohydrate is the remainder, which is what makes it rise
  // automatically on the days that need it.
  const proteinG = Math.round(cfg.protein_g_per_kg * weightKg);
  const fatG = Math.round(cfg.fat_g_per_kg * weightKg);
  const carbG = Math.max(0, Math.round((kcal - proteinG * 4 - fatG * 9) / 4));

  return {
    date,
    kcal,
    proteinG,
    fatG,
    carbG,
    exerciseKcal,
    maintenanceKcal,
    onBikeCarb: carbRate(rideMinutes, hardestIf, cfg),
    rideMinutes,
    isFuelDay: fuelDay,
  };
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

// The calendar note. Pushed as a NOTE-category event, whose description is free
// prose: Intervals.icu only parses `- duration target` lines into workout steps,
// and a note has none, so it renders verbatim (verified against the account —
// a prose description comes back with `steps: []`).
export function fuelNoteName(t: FuelTargets): string {
  return `Fuel ${num(t.kcal)} kcal · ${t.proteinG}g protein`;
}

export function fuelNoteDescription(t: FuelTargets): string {
  const lines: string[] = [];
  lines.push(`${num(t.kcal)} kcal · ${t.proteinG}g protein · ${t.carbG}g carb · ${t.fatG}g fat.`);
  lines.push("");

  if (t.onBikeCarb) {
    const { loGPerHour, hiGPerHour } = t.onBikeCarb;
    const hours = t.rideMinutes / 60;
    const totalLo = Math.round(loGPerHour * hours);
    const totalHi = Math.round(hiGPerHour * hours);
    lines.push(
      `On the bike: ${loGPerHour}-${hiGPerHour}g carb/h during (~${totalLo}-${totalHi}g total). ` +
        `This is part of the ${num(t.kcal)} kcal, not on top of it — cutting on-bike fuel to ` +
        `make the deficit is how a fat-loss block turns into a fitness-loss block.`,
    );
  } else if (t.rideMinutes > 0) {
    lines.push(
      "On the bike: no carbs needed. Short and easy is the place to ride low-carb and take " +
        "the deficit, so quality days keep their fuel.",
    );
  }

  lines.push("");
  lines.push(
    t.isFuelDay
      ? "Fuel day — at or near maintenance. The session is the point; feed it."
      : "Deficit day — this is where the week's deficit is taken.",
  );
  lines.push(
    `Protein in 4 feedings of ~${Math.round(t.proteinG / 4)}g, plus ~40g casein before sleep.`,
  );
  lines.push("");
  lines.push(
    `Maintenance for this day ~${num(t.maintenanceKcal)} kcal ` +
      `(${num(t.exerciseKcal)} kcal of it planned training). Estimated — calibrate against the ` +
      `7-day rolling weight trend, not this number.`,
  );
  return lines.join("\n");
}

// Latest logged body weight in the fetched wellness window. Weigh-ins are
// sparse (travel, forgotten mornings), so this walks back rather than requiring
// today's entry — but it deliberately does not average: the fuelling model
// wants the most recent truth, and the 7-day rolling average is the athlete's
// decision signal, not the prescription's input.
export function latestWeightKg(entries: { date: string; weight?: number }[]): number | null {
  const withWeight = entries
    .filter((e) => typeof e.weight === "number" && e.weight > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = withWeight[withWeight.length - 1];
  return latest ? (latest.weight as number) : null;
}

// Whole years elapsed, for the RMR term. Date-only arithmetic on the ISO
// strings: the birthday has passed this year unless the month/day is still
// ahead of us.
export function ageOn(dateOfBirth: string, onDate: string): number {
  const [by, bm, bd] = dateOfBirth.slice(0, 10).split("-").map(Number);
  const [ny, nm, nd] = onDate.slice(0, 10).split("-").map(Number);
  let age = ny - by;
  if (nm < bm || (nm === bm && nd < bd)) age -= 1;
  return age;
}

export function isWithinBlock(date: string, cfg: FuelingConfig): boolean {
  if (cfg.start_date && date < cfg.start_date) return false;
  if (cfg.end_date && date > cfg.end_date) return false;
  return true;
}

export interface FuelContext {
  weightKg: number;
  heightCm: number;
  ageYears: number;
  ftp: number;
}

// One NOTE event per planned day inside the block window. Rest days are
// included on purpose — they carry the deepest deficit and are exactly the days
// the athlete has no other calendar entry to read. Holiday/travel days are
// skipped: the plan already treats them as maintenance, and prescribing a
// deficit against a day with no plan behind it would be guesswork.
export function fuelNoteEvents(
  planned: PlannedWorkout[],
  ctx: FuelContext,
  cfg: FuelingConfig,
): IntervalsEvent[] {
  if (!cfg.enabled) return [];
  const byDate = new Map<string, PlannedWorkout[]>();
  for (const w of planned) {
    if (w.type === "travel") continue;
    if (!isWithinBlock(w.date, cfg)) continue;
    const list = byDate.get(w.date);
    if (list) list.push(w);
    else byDate.set(w.date, [w]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, workouts]) => {
      const targets = fuelTargetsFor({ date, workouts, ...ctx }, cfg);
      return {
        // Same time-component requirement as every other event we write: the
        // API rejects a bare YYYY-MM-DD with a 422.
        start_date_local: `${date}T00:00:00`,
        name: fuelNoteName(targets),
        category: "NOTE",
        type: "Note",
        description: fuelNoteDescription(targets),
      };
    });
}
