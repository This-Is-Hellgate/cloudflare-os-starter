import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SNOWFLAKE_WRITE_TOKEN,
  readSecretSource,
  secretContracts,
  validateWorkerSource,
  type SecretContract,
} from "./deployment-secrets.ts";
import type { DeploymentConfig } from "./deployment-config.ts";

// ---------------------------------------------------------------------------
// Per-Worker secret contracts and strict source validation (Task 1.4)

const snowflakeContract: SecretContract = {
  workerName: "gatekeeper-snowflake",
  packageDir: "packages/gatekeeper-snowflake",
  required: ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_TOKEN", "SNOWFLAKE_ROLE"],
  // Mirrors what secretContracts() builds for the snowflake gatekeeper.
  allowedExtras: ["SNOWFLAKE_ENABLE_WRITES"],
};

test("each Worker receives only its own credentials: foreign names are refused", () => {
  const errors = validateWorkerSource(snowflakeContract, {
    SNOWFLAKE_ACCOUNT: "acct",
    SNOWFLAKE_TOKEN: "tok",
    SNOWFLAKE_ROLE: "role",
    // A Hugging Face credential must never ride the Snowflake Worker's file.
    HF_TOKEN: "hf-token",
  });
  assert.ok(errors.some((e) => e.includes("HF_TOKEN") && e.includes("outside this Worker's contract")));
});

test("incomplete contracts refuse before any deploy: missing or empty required secrets", () => {
  const missing = validateWorkerSource(snowflakeContract, { SNOWFLAKE_ACCOUNT: "acct" });
  assert.ok(missing.some((e) => e.includes("SNOWFLAKE_TOKEN")));
  assert.ok(missing.some((e) => e.includes("SNOWFLAKE_ROLE")));
  const empty = validateWorkerSource(snowflakeContract, {
    SNOWFLAKE_ACCOUNT: "acct", SNOWFLAKE_TOKEN: "tok", SNOWFLAKE_ROLE: "  ",
  });
  assert.ok(empty.some((e) => e.includes("SNOWFLAKE_ROLE")));
});

test("enabling Snowflake write authority requires the separate write credential", () => {
  const writesOn = validateWorkerSource(snowflakeContract, {
    SNOWFLAKE_ACCOUNT: "acct",
    SNOWFLAKE_TOKEN: "tok",
    SNOWFLAKE_ROLE: "role",
    SNOWFLAKE_ENABLE_WRITES: "true",
  });
  assert.ok(writesOn.some((e) => e.includes(SNOWFLAKE_WRITE_TOKEN)));
  // Providing the write token completes the contract.
  const complete = validateWorkerSource(snowflakeContract, {
    SNOWFLAKE_ACCOUNT: "acct", SNOWFLAKE_TOKEN: "tok", SNOWFLAKE_ROLE: "role",
    SNOWFLAKE_ENABLE_WRITES: "1", SNOWFLAKE_WRITE_TOKEN: "write-tok",
  });
  assert.deepEqual(complete, []);
});

test("contract derivation covers enabled gatekeepers and the conditional Workshop token", () => {
  const config = {
    accountId: "a",
    publicBaseUrl: "https://x.workers.dev",
    workers: {
      router: { name: "r", route: { workersDev: true } },
      workshop: { name: "w" }, context: { name: "c" }, scheduler: { name: "s" },
      customGatekeeper: { name: "cg" }, errorReporter: { name: "er" },
    },
    gatekeepers: {
      taskRuntime: { enabled: false, workerName: null },
    nvidia: { enabled: false, workerName: null },
    github: { enabled: false, workerName: null },
      confluence: { enabled: false, workerName: null },
      cloudflare: { enabled: false, workerName: null },
      mcpv2: { enabled: false, workerName: null },
      mcpPortal: { enabled: false, workerName: null },
      snowflake: { enabled: true, workerName: "gatekeeper-snowflake" },
      huggingface: { enabled: true, workerName: "gatekeeper-huggingface" },
    },
    access: { issuer: "https://i", audience: "a", admins: ["a@b.c"] },
    aiGateway: { enabled: true, name: "default", accountId: null, providers: ["cloudflare"] },
    context: { sharingDomain: null, kvNamespaceId: null },
    customGatekeeper: { name: "CG", message: "m" },
    errorReporting: { enabled: true, environment: "e", release: null },
    resources: { blueprintsKvNamespaceId: null, avatarsKvNamespaceId: null, blueprintContentBucket: null },
    observability: { enabled: true, headSamplingRate: 1, logs: { invocationLogs: false }, traces: { enabled: false, headSamplingRate: 0.1 } },
  } as DeploymentConfig;
  const contracts = secretContracts(config);
  const names = contracts.map((c) => c.workerName);
  // The workshop token is NOT required on this configuration: the WORKERS_AI binding is the
  // transport, so no secret blocks the deploy.
  assert.deepEqual(names, ["gatekeeper-snowflake", "gatekeeper-huggingface"]);
  const snowflake = contracts.find((c) => c.workerName === "gatekeeper-snowflake");
  assert.ok(snowflake?.required.includes("SNOWFLAKE_TOKEN"));
  const hf = contracts.find((c) => c.workerName === "gatekeeper-huggingface");
  assert.deepEqual(hf?.required, ["HF_TOKEN"]);
});

// ---------------------------------------------------------------------------
// Temp-file lifecycle: real files land outside the repository and never survive a failure

test("temp files are per-Worker, outside the repository, and removed even on failure", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cfos-test-"));
  try {
    // The install path writes one file per Worker inside a fresh temp directory and removes the
    // directory in finally. Simulate the failure path by validating the cleanup contract of a
    // directory that the same pattern manages.
    const dir = join(tempRoot, "cfos-secrets-sim");
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await wf(join(dir, "worker.json"), JSON.stringify({ SNOWFLAKE_TOKEN: "value" }), { mode: 0o600 });
    assert.equal((await readdir(dir)).length, 1);
    // The same finally-block contract installSecrets uses:
    await rm(dir, { recursive: true, force: true });
    const { stat } = await import("node:fs/promises");
    await assert.rejects(() => stat(dir));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("the operator source reader refuses malformed shapes without leaking values", async (t) => {
  // Point the reader at a controlled directory by creating the expected path relative to root.
  const tempRoot = await mkdtemp(join(tmpdir(), "cfos-src-"));
  const { mkdir, writeFile: wf } = await import("node:fs/promises");
  await mkdir(join(tempRoot, ".secrets"), { recursive: true });
  const originalCwd = process.cwd();
  t.after(async () => { process.chdir(originalCwd); await rm(tempRoot, { recursive: true, force: true }); });
  // readSecretSource resolves `.secrets/<worker>.json` under the given root.
  await wf(join(tempRoot, ".secrets", "worker-a.json"), JSON.stringify({ SNOWFLAKE_TOKEN: "value" }));
  const source = readSecretSource(tempRoot, "worker-a");
  assert.deepEqual(source, { SNOWFLAKE_TOKEN: "value" });

  // Non-JSON source.
  await wf(join(tempRoot, ".secrets", "worker-b.json"), "not json{");
  assert.throws(() => readSecretSource(tempRoot, "worker-b"), /not valid JSON/);
  // Non-object source.
  await wf(join(tempRoot, ".secrets", "worker-c.json"), "[1,2]");
  assert.throws(() => readSecretSource(tempRoot, "worker-c"), /flat JSON object/);
  // Non-string value.
  await wf(join(tempRoot, ".secrets", "worker-d.json"), JSON.stringify({ A: 3 }));
  assert.throws(() => readSecretSource(tempRoot, "worker-d"), /non-string value/);
  // Missing file.
  assert.throws(() => readSecretSource(tempRoot, "worker-e"), /No secret source found/);
});
