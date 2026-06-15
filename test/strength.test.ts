import { describe, it, expect } from "vitest";
import {
  MARKER,
  formatExercise,
  buildDescription,
  type StrengthExercise,
} from "../src/strength.js";

// fmtWeight and setToken are not exported, so they're exercised through
// formatExercise / buildDescription (the public surface).

function ex(name: string, sets: Partial<StrengthExercise["sets"][number]>[]): StrengthExercise {
  return {
    name,
    sets: sets.map((s) => ({
      weightLb: 0,
      reps: 0,
      seconds: 0,
      rpe: "",
      note: "",
      ...s,
    })),
  };
}

describe("formatExercise", () => {
  it("formats a loaded set as reps@weightlb", () => {
    expect(formatExercise(ex("Squat", [{ reps: 6, weightLb: 90 }]))).toBe("Squat: 6@90lb");
  });

  it("drops a trailing .0 but keeps a real fraction (fmtWeight, nearest 0.5)", () => {
    expect(formatExercise(ex("A", [{ reps: 5, weightLb: 60.0 }]))).toBe("A: 5@60lb");
    expect(formatExercise(ex("B", [{ reps: 5, weightLb: 22.5 }]))).toBe("B: 5@22.5lb");
    expect(formatExercise(ex("C", [{ reps: 5, weightLb: 60.2 }]))).toBe("C: 5@60lb"); // → 60.0
    expect(formatExercise(ex("D", [{ reps: 5, weightLb: 22.4 }]))).toBe("D: 5@22.5lb"); // → 22.5
  });

  it("renders a bodyweight set (weight 0) as bare reps", () => {
    expect(formatExercise(ex("Pull Up", [{ reps: 10 }]))).toBe("Pull Up: 10");
  });

  it("renders a time-based set as seconds, and seconds wins over reps", () => {
    expect(formatExercise(ex("Plank", [{ seconds: 30 }]))).toBe("Plank: 30s");
    expect(formatExercise(ex("Hold", [{ seconds: 45, reps: 99, weightLb: 50 }]))).toBe("Hold: 45s");
  });

  it("collapses identical sets to NxToken", () => {
    expect(
      formatExercise(
        ex("Row", [
          { reps: 10, weightLb: 40 },
          { reps: 10, weightLb: 40 },
          { reps: 10, weightLb: 40 },
        ]),
      ),
    ).toBe("Row: 3×10@40lb");
  });

  it("lists mixed sets comma-separated", () => {
    expect(
      formatExercise(
        ex("Push Up", [
          { reps: 13, weightLb: 10 },
          { reps: 8, weightLb: 10 },
          { reps: 6, weightLb: 10 },
        ]),
      ),
    ).toBe("Push Up: 13@10lb, 8@10lb, 6@10lb");
  });

  it("appends a single shared RPE but omits it when RPE varies", () => {
    expect(
      formatExercise(
        ex("Deadlift", [
          { reps: 6, weightLb: 60, rpe: "7" },
          { reps: 6, weightLb: 60, rpe: "7" },
        ]),
      ),
    ).toBe("Deadlift: 2×6@60lb @RPE7");

    expect(
      formatExercise(
        ex("Deadlift", [
          { reps: 6, weightLb: 60, rpe: "7" },
          { reps: 6, weightLb: 60, rpe: "8" },
        ]),
      ),
    ).toBe("Deadlift: 2×6@60lb"); // mixed RPE → omitted
  });

  it("dedupes a repeated exercise note to one parenthetical", () => {
    expect(
      formatExercise(
        ex("Split Squat", [
          { reps: 5, weightLb: 30, note: "37 Gray -2" },
          { reps: 5, weightLb: 30, note: "37 Gray -2" },
        ]),
      ),
    ).toBe("Split Squat: 2×5@30lb (37 Gray -2)");
  });
});

describe("buildDescription", () => {
  it("starts with MARKER and lists one line per exercise", () => {
    const out = buildDescription([
      ex("Squat", [{ reps: 6, weightLb: 90 }]),
      ex("Plank", [{ seconds: 30 }]),
    ]);
    expect(out.split("\n")[0]).toBe(MARKER);
    expect(out).toBe(`${MARKER}\nSquat: 6@90lb\nPlank: 30s`);
  });

  it("filters out exercises with no sets", () => {
    const out = buildDescription([ex("Squat", [{ reps: 6, weightLb: 90 }]), ex("Empty", [])]);
    expect(out).toBe(`${MARKER}\nSquat: 6@90lb`);
  });
});
