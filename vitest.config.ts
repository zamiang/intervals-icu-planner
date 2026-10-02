import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Agent worktrees live under .claude/worktrees with their own test/ copies;
    // without this, `npm test` runs every stale checkout alongside this one.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
