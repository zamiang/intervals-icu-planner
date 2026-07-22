import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-config-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const VALID_YAML = `
weight_training:
  name: "Strength Session"
  duration_minutes: 60
  description: "Squat 3x8, Deadlift 3x5"

sweet_spot:
  name: "Sweet Spot Intervals"
  duration_minutes: 60
  description: "4x10min at 60rpm"

scheduling:
  tsb_fresh: 5
  tsb_fatigued: -10
  weight_sessions: 2
  min_weight_gap_days: 2
`;

describe("loadConfig", () => {
  it("parses a valid config file", async () => {
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, VALID_YAML, "utf8");

    const config = await loadConfig(file);

    expect(config.weight_training.name).toBe("Strength Session");
    expect(config.weight_training.duration_minutes).toBe(60);
    expect(config.sweet_spot.name).toBe("Sweet Spot Intervals");
    expect(config.scheduling.tsb_fresh).toBe(5);
    expect(config.scheduling.tsb_fatigued).toBe(-10);
    expect(config.scheduling.weight_sessions).toBe(2);
  });

  it("applies defaults for missing scheduling fields", async () => {
    const minimal = `
weight_training:
  name: "Strength"
  duration_minutes: 45
  description: "Basic routine"

sweet_spot:
  name: "Sweet Spot"
  duration_minutes: 60
  description: "Slow grinding"
`;
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, minimal, "utf8");

    const config = await loadConfig(file);

    expect(config.scheduling.tsb_fresh).toBe(5);
    expect(config.scheduling.tsb_fatigued).toBe(-10);
    expect(config.scheduling.tsb_very_fatigued).toBe(-20);
    expect(config.scheduling.weight_sessions).toBe(2);
    expect(config.scheduling.weight_sessions_very_fatigued).toBe(1);
    expect(config.scheduling.min_weight_gap_days).toBe(2);
    expect(config.scheduling.max_weekly_ramp_pct).toBe(7);
    expect(config.ftp_sync).toEqual({ enabled: true, max_change_pct: 10 });
  });

  it("accepts ftp_sync overrides and rejects invalid values", async () => {
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(
      file,
      `${VALID_YAML}\nftp_sync:\n  enabled: false\n  max_change_pct: 5\n`,
      "utf8",
    );
    const config = await loadConfig(file);
    expect(config.ftp_sync).toEqual({ enabled: false, max_change_pct: 5 });

    const bad = path.join(tmpDir, "bad.yaml");
    await fs.writeFile(bad, `${VALID_YAML}\nftp_sync:\n  max_change_pct: -3\n`, "utf8");
    await expect(loadConfig(bad)).rejects.toThrow("ftp_sync.max_change_pct");
  });

  it("applies holidays defaults when the section is absent", async () => {
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, VALID_YAML, "utf8");
    const config = await loadConfig(file);
    expect(config.holidays).toEqual({ enabled: true, mode: "skip", lookback_days: 60 });
  });

  it("accepts holidays overrides and rejects invalid values", async () => {
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(
      file,
      `${VALID_YAML}\nholidays:\n  enabled: false\n  mode: placeholder\n  lookback_days: 30\n`,
      "utf8",
    );
    const config = await loadConfig(file);
    expect(config.holidays).toEqual({ enabled: false, mode: "placeholder", lookback_days: 30 });

    const badMode = path.join(tmpDir, "bad-mode.yaml");
    await fs.writeFile(badMode, `${VALID_YAML}\nholidays:\n  mode: vacation\n`, "utf8");
    await expect(loadConfig(badMode)).rejects.toThrow("holidays.mode");

    const badLookback = path.join(tmpDir, "bad-lookback.yaml");
    await fs.writeFile(badLookback, `${VALID_YAML}\nholidays:\n  lookback_days: -1\n`, "utf8");
    await expect(loadConfig(badLookback)).rejects.toThrow("holidays.lookback_days");
  });

  it("accepts a max_weekly_ramp_pct override", async () => {
    const yaml = `
weight_training:
  name: "Strength"
  duration_minutes: 60
  description: "test"

sweet_spot:
  name: "LC"
  duration_minutes: 60
  description: "test"

scheduling:
  max_weekly_ramp_pct: 5
`;
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, yaml, "utf8");
    const config = await loadConfig(file);
    expect(config.scheduling.max_weekly_ramp_pct).toBe(5);
  });

  it("throws if weight_training is missing", async () => {
    const bad = `
sweet_spot:
  name: "Sweet Spot"
  duration_minutes: 60
  description: "test"
`;
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, bad, "utf8");

    await expect(loadConfig(file)).rejects.toThrow("weight_training");
  });

  it("throws if sweet_spot is missing", async () => {
    const bad = `
weight_training:
  name: "Strength"
  duration_minutes: 60
  description: "test"
`;
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, bad, "utf8");

    await expect(loadConfig(file)).rejects.toThrow("sweet_spot");
  });

  it("applies a single scheduling override while keeping other defaults", async () => {
    const yaml = `
weight_training:
  name: "Strength"
  duration_minutes: 60
  description: "test"

sweet_spot:
  name: "LC"
  duration_minutes: 60
  description: "test"

scheduling:
  tsb_fresh: 10
`;
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, yaml, "utf8");

    const config = await loadConfig(file);
    expect(config.scheduling.tsb_fresh).toBe(10);
    expect(config.scheduling.tsb_fatigued).toBe(-10);
    expect(config.scheduling.weight_sessions).toBe(2);
    expect(config.scheduling.min_weight_gap_days).toBe(2);
  });

  it("defaults periodization and weight_sessions_taper when absent", async () => {
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, VALID_YAML);
    const config = await loadConfig(file);
    expect(config.periodization).toEqual({
      taper_weeks: 4,
      taper_zero_weeks: 1,
      race_date: null,
    });
    expect(config.scheduling.weight_sessions_taper).toBe(1);
    expect(config.weight_training_taper).toBeUndefined();
  });

  it("loads an optional taper routine and periodization overrides", async () => {
    const file = path.join(tmpDir, "config.yaml");
    const yamlWithTaper =
      VALID_YAML.replace("scheduling:", "scheduling:\n  weight_sessions_taper: 1") +
      `
weight_training_taper:
  name: "Taper Lift"
  duration_minutes: 30
  description: "Squat + deadlift, 2 sets"
periodization:
  taper_weeks: 3
  taper_zero_weeks: 2
  race_date: "2026-09-26"
`;
    await fs.writeFile(file, yamlWithTaper);
    const config = await loadConfig(file);
    expect(config.weight_training_taper).toEqual({
      name: "Taper Lift",
      duration_minutes: 30,
      description: "Squat + deadlift, 2 sets",
    });
    expect(config.periodization.taper_weeks).toBe(3);
    expect(config.periodization.taper_zero_weeks).toBe(2);
    expect(config.periodization.race_date).toBe("2026-09-26");
  });

  it("throws when a scheduling field has the wrong type", async () => {
    const yaml = `
weight_training:
  name: "Strength"
  duration_minutes: 60
  description: "test"

sweet_spot:
  name: "LC"
  duration_minutes: 60
  description: "test"

scheduling:
  tsb_fresh: "five"
`;
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, yaml, "utf8");

    await expect(loadConfig(file)).rejects.toThrow("tsb_fresh");
  });

  it("throws when rhr_artifact_bpm is not above rhr_rise_bpm", async () => {
    const yaml =
      VALID_YAML +
      `
readiness:
  rhr_rise_bpm: 7
  rhr_artifact_bpm: 6
`;
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, yaml, "utf8");

    await expect(loadConfig(file)).rejects.toThrow("rhr_artifact_bpm");
  });
});

describe("repo config.yaml", () => {
  // Intervals.icu parses WORKOUT-event descriptions as plain-text workouts,
  // where `37"` means 37 seconds and `5'` means 5 minutes. A prose description
  // containing such tokens (e.g. a 37-inch band written as `37"`) gets turned
  // into a bogus seconds-long workout_doc that overrides the event's explicit
  // moving_time at creation — and the completed activity then fails to
  // auto-pair (planned session shows 0% compliance). Keep prose descriptions
  // free of digit/quote duration tokens; write "37-inch" instead.
  it("keeps prose workout descriptions free of duration-like tokens", async () => {
    const config = await loadConfig("config.yaml");
    const proseDescriptions = [
      ["weight_training", config.weight_training.description],
      ["weight_training_taper", config.weight_training_taper?.description ?? ""],
    ] as const;
    for (const [name, description] of proseDescriptions) {
      expect(description, `${name}.description contains a duration-like token`).not.toMatch(
        /\d["']|["']\d/,
      );
    }
  });
});
