// Vitest's defaults, plus the Claude Code session worktrees under `.claude/`:
// on the Mac they are full checkouts inside this one, so `yarn test` from the
// main checkout would run every worktree's suite too.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
