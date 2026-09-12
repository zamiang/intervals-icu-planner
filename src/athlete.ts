import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { AthleteProfile } from "./intervals.js";

// Personal anthropometrics, kept in a local file that is never committed.
//
// Height, date of birth and sex are the fuelling model's only genuinely
// personal inputs — they identify the athlete in a way the rest of config.yaml
// does not, and this repository is public. Intervals.icu already holds them on
// the account, so the planner can read them from the API; this file exists so
// the numbers can live on disk without ever entering version control, and so a
// run is not at the mercy of the profile endpoint.
//
// See .athlete.example.yaml for the shape.
export const ATHLETE_FILE = ".athlete.yaml";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function field(obj: Record<string, unknown>, name: string): unknown {
  return obj[name];
}

// Parses the local profile, or returns null when the file simply isn't there —
// the common case for a fresh checkout, and the signal to fall back to the API.
//
// A file that exists but is malformed throws instead. A typo'd date of birth
// would otherwise silently shift the RMR estimate by years, and falling back to
// the API on a parse error would hide the mistake behind a plausible-looking
// number.
export async function loadLocalAthlete(
  filePath: string = ATHLETE_FILE,
): Promise<Partial<AthleteProfile> | null> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const doc: unknown = parse(text);
  if (doc == null) return null;
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${filePath} must contain a YAML mapping`);
  }
  const obj = doc as Record<string, unknown>;
  const out: Partial<AthleteProfile> = {};

  const height = field(obj, "height_cm");
  if (height !== undefined && height !== null) {
    if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
      throw new Error(`${filePath}: height_cm must be a positive number`);
    }
    out.heightCm = height;
  }

  const dob = field(obj, "date_of_birth");
  if (dob !== undefined && dob !== null) {
    // A bare YYYY-MM-DD is parsed by the YAML spec as a Date, so accept both
    // that and the quoted string form rather than making the quoting load-bearing.
    const asString =
      dob instanceof Date ? dob.toISOString().slice(0, 10) : typeof dob === "string" ? dob : null;
    if (asString === null || !ISO_DATE.test(asString)) {
      throw new Error(`${filePath}: date_of_birth must be a YYYY-MM-DD date`);
    }
    out.dateOfBirth = asString;
  }

  const sex = field(obj, "sex");
  if (sex !== undefined && sex !== null) {
    if (typeof sex !== "string" || !/^[MF]$/i.test(sex)) {
      throw new Error(`${filePath}: sex must be "M" or "F"`);
    }
    out.sex = sex.toUpperCase();
  }

  return out;
}

// True once the local file alone can drive the fuelling model, which is what
// lets a run skip the profile API call entirely.
export function isCompleteProfile(p: Partial<AthleteProfile> | null): boolean {
  return !!p && p.heightCm != null && p.dateOfBirth != null && p.sex != null;
}

// Local values win over the account: the file is the deliberate, hand-checked
// statement of these numbers, and the API is the fallback for whatever it omits.
export function mergeAthlete(
  local: Partial<AthleteProfile> | null,
  remote: AthleteProfile | null,
): AthleteProfile | null {
  if (!local && !remote) return null;
  return {
    heightCm: local?.heightCm ?? remote?.heightCm ?? null,
    dateOfBirth: local?.dateOfBirth ?? remote?.dateOfBirth ?? null,
    sex: local?.sex ?? remote?.sex ?? null,
  };
}
