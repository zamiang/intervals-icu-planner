// Shared formatting for strength sessions pushed into an Intervals.icu activity
// description. Both the Strong CSV importer and the Hevy API importer normalize
// their data into StrengthExercise[] and render it here, so the two paths
// produce byte-identical descriptions.
//
// Intervals.icu has no structured per-set fields, so the lift detail lives in
// the free-text `description`. Descriptions begin with MARKER, which makes the
// importers idempotent (a re-run recognizes and overwrites its own output but
// leaves hand-written descriptions alone unless forced).

export const MARKER = "— logged from Strong —";
export const KG_TO_LB = 2.2046226218;

export interface StrengthSet {
  weightLb: number; // 0 = bodyweight / no added load
  reps: number;
  seconds: number; // >0 for time-based holds (planks, stretches)
  rpe: string; // "" when not logged
  note: string; // "" when none
}

export interface StrengthExercise {
  name: string;
  sets: StrengthSet[];
}

// Round band/weight numbers to a clean value (nearest 0.5) and drop a trailing
// ".0" so 60.0 → "60" but 22.5 stays "22.5".
function fmtWeight(lb: number): string {
  const rounded = Math.round(lb * 2) / 2;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// Collapse a single set into a compact token: "6@60lb", "15", "30s".
function setToken(s: StrengthSet): string {
  if (s.seconds > 0) return `${s.seconds}s`;
  if (s.weightLb > 0) return `${s.reps}@${fmtWeight(s.weightLb)}lb`;
  return `${s.reps}`;
}

export function formatExercise(ex: StrengthExercise): string {
  const tokens = ex.sets.map(setToken);
  const allSame = tokens.length > 1 && tokens.every((t) => t === tokens[0]);
  const body = allSame ? `${tokens.length}×${tokens[0]}` : tokens.join(", ");
  const rpes = [...new Set(ex.sets.map((s) => s.rpe).filter(Boolean))];
  const rpe = rpes.length === 1 ? ` @RPE${rpes[0]}` : "";
  const notes = [...new Set(ex.sets.map((s) => s.note).filter(Boolean))];
  const note = notes.length ? ` (${notes.join("; ")})` : "";
  return `${ex.name}: ${body}${rpe}${note}`;
}

export function buildDescription(exercises: StrengthExercise[]): string {
  const lines = exercises.filter((e) => e.sets.length > 0).map(formatExercise);
  return `${MARKER}\n${lines.join("\n")}`;
}
