// Vite+ per-package settings. `vitest.config.ts` beside this file is vitest's own config; this
// file exists to declare the `test` task that `vp run` executes. There is no `build` task: this
// package is source-consumed (like stage), so `tsc --noEmit` under `types:check` is the only
// compile gate.
export default {
  run: {
    tasks: {
      test: {
        command: "vitest run",
        input: [{ auto: true }, { pattern: "!**/.wrangler/**", base: "workspace" }],
      },
    },
  },
};
