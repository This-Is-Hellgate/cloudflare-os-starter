// Vite+ per-package settings. `vitest.config.ts` beside this file is vitest's own config (vitest
// prefers it over this one); this file exists to declare the `build` and `test` tasks that
// `vp run` executes. Mirrors packages/gatekeeper-huggingface/vite.config.ts.
export default {
  run: {
    tasks: {
      build: { command: "tsc", input: [{ auto: true }, { pattern: "!dist/**", base: "package" }], output: ["dist/**"] },
      test: { command: "vitest run", input: [{ auto: true }, { pattern: "!**/.wrangler/**", base: "workspace" }] },
    },
  },
};
