import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCompleteProfile, loadLocalAthlete, mergeAthlete } from "../src/athlete.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "athlete-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(contents: string): Promise<string> {
  const path = join(dir, ".athlete.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("loadLocalAthlete", () => {
  it("reads the three personal fields", async () => {
    const path = await write('height_cm: 180\ndate_of_birth: "1990-06-15"\nsex: M\n');
    expect(await loadLocalAthlete(path)).toEqual({
      heightCm: 180,
      dateOfBirth: "1990-06-15",
      sex: "M",
    });
  });

  it("returns null when the file is absent, which is the signal to ask the API", async () => {
    expect(await loadLocalAthlete(join(dir, "nope.yaml"))).toBeNull();
  });

  it("returns null for an empty file rather than treating it as malformed", async () => {
    expect(await loadLocalAthlete(await write("\n"))).toBeNull();
  });

  it("accepts a partial file, leaving the rest to the API", async () => {
    expect(await loadLocalAthlete(await write("sex: F\n"))).toEqual({ sex: "F" });
  });

  it("accepts an unquoted date, which YAML parses as a Date", async () => {
    const got = await loadLocalAthlete(await write("date_of_birth: 1990-06-15\n"));
    expect(got).toEqual({ dateOfBirth: "1990-06-15" });
  });

  it("uppercases sex so the RMR branch never depends on how it was typed", async () => {
    expect(await loadLocalAthlete(await write("sex: f\n"))).toEqual({ sex: "F" });
  });

  // A malformed file must fail loudly: falling back to the API would hide a
  // typo behind a plausible-looking number.
  it("throws on a date that is not YYYY-MM-DD", async () => {
    await expect(loadLocalAthlete(await write('date_of_birth: "09/06/1990"\n'))).rejects.toThrow(
      /date_of_birth/,
    );
  });

  it("throws on a non-positive height", async () => {
    await expect(loadLocalAthlete(await write("height_cm: 0\n"))).rejects.toThrow(/height_cm/);
  });

  it("throws on a sex outside M/F", async () => {
    await expect(loadLocalAthlete(await write("sex: male\n"))).rejects.toThrow(/sex/);
  });

  it("throws when the document is not a mapping", async () => {
    await expect(loadLocalAthlete(await write("- 180\n"))).rejects.toThrow(/mapping/);
  });
});

describe("isCompleteProfile", () => {
  it("is true only when all three fields are present", () => {
    expect(isCompleteProfile({ heightCm: 180, dateOfBirth: "1990-06-15", sex: "M" })).toBe(true);
    expect(isCompleteProfile({ heightCm: 180, dateOfBirth: "1990-06-15" })).toBe(false);
    expect(isCompleteProfile(null)).toBe(false);
  });
});

describe("mergeAthlete", () => {
  it("prefers the local file, which is the hand-checked statement of these numbers", () => {
    const merged = mergeAthlete(
      { heightCm: 180, dateOfBirth: "1990-06-15", sex: "M" },
      { heightCm: 175, dateOfBirth: "1985-01-01", sex: "F" },
    );
    expect(merged).toEqual({ heightCm: 180, dateOfBirth: "1990-06-15", sex: "M" });
  });

  it("fills gaps in the local file from the account", () => {
    const merged = mergeAthlete(
      { sex: "M" },
      { heightCm: 175, dateOfBirth: "1985-01-01", sex: "F" },
    );
    expect(merged).toEqual({ heightCm: 175, dateOfBirth: "1985-01-01", sex: "M" });
  });

  it("is null only when neither source exists", () => {
    expect(mergeAthlete(null, null)).toBeNull();
    expect(mergeAthlete(null, { heightCm: null, dateOfBirth: null, sex: null })).toEqual({
      heightCm: null,
      dateOfBirth: null,
      sex: null,
    });
  });
});
