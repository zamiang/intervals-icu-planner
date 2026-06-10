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
});
