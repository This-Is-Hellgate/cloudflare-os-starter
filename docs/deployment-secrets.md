# First-deploy secrets

Secrets are installed per Worker, from operator-supplied files, through the installed Wrangler —
never through shell arguments, never in one combined file, never inside the repository.

## The operator source

Create one JSON file per Worker in `.secrets/` (gitignored at the repository root):

```
.secrets/<workerName>.json        e.g. .secrets/gatekeeper-snowflake.json
```

Each file is a flat map of secret name to value:

```json
{
  "SNOWFLAKE_ACCOUNT": "myorg",
  "SNOWFLAKE_TOKEN": "...",
  "SNOWFLAKE_ROLE": "READER_ROLE"
}
```

## The contract

Each Worker receives **only its own credentials**. The contract comes from the deployment
configuration:

| Worker | Required secrets |
| --- | --- |
| workshop | `CF_AI_GATEWAY_API_TOKEN`, only when the AI Gateway plan needs a token |
| gatekeeper-snowflake | `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_TOKEN`, `SNOWFLAKE_ROLE` |
| gatekeeper-huggingface | `HF_TOKEN` |

Validation is strict and fails **before** anything is installed:

- **Completeness** — every required secret must be present and non-empty.
- **Isolation** — names outside the Worker's contract are refused. A Hugging Face token can never
  ride the Snowflake Worker's file, and vice versa.

## Snowflake write authority

Write execution is gated by `SNOWFLAKE_ENABLE_WRITES`. When you set it (`"true"`/`"1"`) in the
Worker's source file, the contract additionally requires **`SNOWFLAKE_WRITE_TOKEN`** — a separate
write credential used only by the approved-write path (`SNOWFLAKE_WRITE_ROLE` /
`SNOWFLAKE_WRITE_WAREHOUSE` scope it further).

The existing read credential may be reused as the write token only after you have checked its
scope: create the value deliberately (`"SNOWFLAKE_WRITE_TOKEN": "<same value>"`) with the
understanding that it then carries write authority. A checked, narrower write credential is the
recommended setup.

## Installing

```sh
# Validate every Worker's contract without installing anything (no values loaded past validation):
node scripts/deploy.ts --check --with-secrets

# Install before (or between) deploys:
node scripts/deployment-secrets.ts ... via: node scripts/deploy.ts --with-secrets
```

`--with-secrets` on a real deploy installs the contracted secrets **before** the Workers deploy
(draft Workers receive their credentials first, so a first deploy succeeds). Values are written to
one temporary file per Worker **outside the repository** (OS temp directory), restricted to the
current user (mode `0600` on POSIX; on Windows the user-scoped `%TEMP%` ACL applies and a
read-only attribute is set best-effort), handed to the installed Wrangler's
`wrangler secret bulk <file> --name <worker>`, and **removed in `finally`** — including on
validation or deploy failures.

### After a hard kill

If the process is terminated hard enough to skip `finally`, leftover files live only in the OS
temp directory (never the repository) under a `cfos-secrets-` prefix. Remove them manually:

```powershell
# Windows (PowerShell)
Get-ChildItem $env:TEMP -Filter "cfos-secrets-*" -Directory | Remove-Item -Recurse -Force
```

```sh
# Linux
rm -rf "${TMPDIR:-/tmp}"/cfos-secrets-*
```

Dry runs (`--check`) validate the contracts and install nothing.
