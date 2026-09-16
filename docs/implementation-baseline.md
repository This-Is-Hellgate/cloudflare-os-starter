# Implementation Baseline

Recorded September 15, 2026 as the starting point for the Full Code Mode and Gatekeeper
implementation program (`docs/superpowers/plans/2026-09-15-full-code-mode-and-gatekeepers.md`).
This file exists so the implementation target can be reproduced without the originating
conversation or any external file.

## Repository state

| Item | Value |
|---|---|
| Outer HEAD | `ff8fb79d4ba34dd59180e8fe4cb82b71f83f11ff`, branch `main` |
| Submodule gitlink (`cloudflare-os`) | `45ae8c21b4b6b30ca81f69fc1f65db1f42a89278` (clean, matches `remotes/origin/HEAD`) |
| Dirty paths at baseline | `deployment.jsonc` (modified: Snowflake enabled with worker name `hellgate-os-gatekeeper-snowflake`); untracked `.deploy-log.txt` (empty) and `docs/superpowers/` |
| Tracked file named `-` | Present at repo root; unrelated cleanup candidate, excluded from this program |
| Baseline proposal commit | `dcc64f2a7e036258a59e7807757b17b86d34a880` — **not retrievable** from this checkout (`git cat-file -t` fails; not an ancestor of HEAD). Ancestry/diff against the original proposal is therefore **not established**; do not assume it. |
>
> **Resolved September 15:** the original baseline commit surfaced on the personal remote and was
> merged into `main` (`613539f`); ancestry is now established. It adds only the original
> `.github/workflows/verify.yml`. |

## Toolchain

| Item | Value |
|---|---|
| Node | `v24.19.0` |
| pnpm | `11.17.0` |
| Outer Wrangler (dry run) | `4.130.0` |
| Inner Wrangler (dry run) | `4.128.0` |
| TypeScript | `7.0.2` (catalog, exact) |
| Lockfile hashes (SHA-256) | outer `pnpm-lock.yaml` `96dda39d163b18c60f94af16ba84383f34b136e88f12219a57ed07ddf921a6ec`; inner `cloudflare-os/pnpm-lock.yaml` `8f37a72acc0de4b01ad421c5540a7fd05a88df97d74de21ce54688b50b704b0f` |

The outer workspace catalog mirrors the submodule's byte-for-byte; the outer `typescript` catalog
entry is deliberately 7.x while the submodule aliases `typescript6` — documented toolchain
divergence, preserved. The inner lockfile is preserved untouched.

## Enabled optional Gatekeepers (deployment.jsonc, user change preserved)

| Gatekeeper | Enabled | Worker name |
|---|---|---|
| snowflake | **yes** (user's local change) | `hellgate-os-gatekeeper-snowflake` |
| github, confluence, cloudflare, mcp, mcpPortal, huggingface | no | — |

Outer packages present at baseline: `cursor`, `stage`, `custom-gatekeeper`, `error-reporter`,
`gatekeeper-snowflake`, `gatekeeper-huggingface`.

## Commands and results at baseline (after P0 repairs)

Recorded on Windows (`win32`); CI also verifies Linux (see `.github/workflows/ci.yml`).

```
git rev-parse HEAD          -> ff8fb79d4ba34dd59180e8fe4cb82b71f83f11ff
git submodule status        -> 45ae8c21b4b6b30ca81f69fc1f65db1f42a89278 cloudflare-os (remotes/origin/HEAD)
git status --short          ->  M deployment.jsonc / ?? .deploy-log.txt / ?? docs/superpowers/
node --version              -> v24.19.0
pnpm --version              -> 11.17.0
pnpm exec wrangler --version-> 4.130.0
```

- `pnpm test` — pass. 36 script tests (`node --test scripts/**/*.test.ts`) plus package suites
  (2+2+19+10+19+46 = 98 vitest tests): 134 total, 0 failures.
- `pnpm lint` — pass (0 errors, 2 pre-existing warnings in
  `packages/cursor/__tests__/cursor.test.ts` and `scripts/deploy.test.ts`; non-failing).
- `pnpm check` — pass (boundary check clean, build + Wrangler dry runs succeed).
- `node scripts/deploy.ts --check --config scripts/deployment.ci.jsonc` — pass (non-secret CI
  fixture validates and dry-runs).

Baseline lint state *before* the P0 repairs: 7 errors (2 mutating `sort()` in stage tests, 3
unused imports in `gatekeeper-snowflake/src/snowflake.ts`, 1 unused variable in
`sql-pages.test.ts`, 1 mutating `sort()` in snowflake.ts) and 2 warnings. These were repaired in
Task 0.2; no provider code was restructured as part of lint cleanup.

## CI

No `.github/workflows/` directory existed at baseline; remote CI status was not verifiable.
`.github/workflows/ci.yml` now runs `pnpm test`, `pnpm lint`, `pnpm check:boundary`, and a
deployment dry run against `scripts/deployment.ci.jsonc` on `ubuntu-latest` and `windows-latest`,
with Node 24.19.0 / pnpm 11.17.0 and frozen installs for both workspace roots. CI runs with no
vendor credentials and no remote deployments: dry runs verify bundling and configuration, not live
permissions.
