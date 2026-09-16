# Task runtime: upstream integration seam

Verification notes for the durable task runtime (plan Task 4.1,
`docs/superpowers/plans/2026-09-15-full-code-mode-and-gatekeepers.md`). Every claim below was
read from the pinned kernel source; quoted phrases are source text. Kernel paths are relative to
`cloudflare-os/`. Terminology follows `docs/code-mode-operator-guide.md`.

## The seam

The coordinator is a gadget: a `WorkerEntrypoint`-shaped `DurableObject` class named `Gadget`,
loaded by the overseer as a per-workpiece facet. The load path fixes the properties the seam
depends on:

- `loadGadgetWorker` builds the facet's env with `getEnvForLoader(gadgetId,
  {from: "gadget", chatId, gadgetId}, chatId)`: `env.GADGET` plus every edge in
  `visibleBindings(gadget, forChatId)` resolved through `makeBindingLoopback`. It also sets the
  compatibility flag `"allow_irrevocable_stub_storage"` with the comment
  `// Make ctx.restore() available.` — persistent-stub creation is a load-time property of the
  facet, not a global.
- The facet is only reachable through overseer-minted restore stubs. `getGadgetFacetFetcher`
  returns `await this.ctx.restore(params)` and documents why: *"the runtime only lets a facet
  call *its* ctx.restore() when the request reached it through a stub the parent created with
  ctx.restore()"*. That is what makes `this.ctx.restore(params)` legal inside gadget code, and
  it chains: a persistent stub minted by the facet restores back through the facet, so hook
  callbacks survive as gadget code.

Registration flow through the Scheduler session (`packages/gatekeeper-scheduler/src/`):

1. The coordinator defines `[restore](params)` on its `Gadget` class returning an `RpcTarget`
   implementing `ScheduledTaskHook.onSchedule(firing)`. `params` must be serializable and are
   replayed *"both immediately and when restoring the callback later"*
   (`packages/gatekeeper-scheduler/src/types.d.ts`). The restored target *"does not inherit the
   Gadget's ctx"* — pass dependencies (e.g. `this.ctx.storage`) into it explicitly.
2. Gadget code calls `this.ctx.restore({type: "...", ...})` to get the persistent callback stub,
   then uses its `SCHEDULER` binding (`SchedulerGatekeeper.describe()` returns
   `suggestedBindingName: "SCHEDULER"`, `tsType: "ScheduleSession"`, `hookTsType:
   "ScheduledTaskHook"`). The env entry is a `GatekeeperLoopback` Fetcher; the overseer resolves
   it via `startGatekeeperSession` into `SchedulerGatekeeper.startSession(approvalQueue)`, which
   returns a `ScheduleSessionImpl` scoped to the inherited `workspaceId` (it throws on an invalid
   scope: *"Invalid inherited scheduler workspace scope."*).
3. `session.runAt/every/calendarAt(when, callback, options)` → `#register` in
   `packages/gatekeeper-scheduler/src/scheduler.ts`: mint a `ScheduleHookController`
   (`WorkerEntrypoint` carrying `{accountId, workspaceId, scheduleId, spec, ...}`), then
   `approvalQueue.bindHook(controller, callback, {title, description})`. On the overseer side,
   `bindHook` writes a `BoundHookRecord {id, actionId, gatekeeperId, controller, callback,
   description, enabled: false}` — the comment reads *"Hooks start out disabled, until the user
   enables them"* — plus a `bindHook` `ActionRecord`, and returns the `scheduleId` immediately.
   The coordinator persists that ID in its own DO storage as the registration receipt.
4. The user enables the hook in Connections: `OverseerClientInterface.enableHook(id)` calls
   `record.controller.enable(GatekeeperHookLoopback, {workspaceId, gadgetId})` →
   `enableScheduleController` → `ScheduleDriver.enable(...)`, which stores the activation and a
   `caps:` record holding the `HookInitiator` — then `enableHookRecord` flips `enabled: true`,
   stamps the action log, and diffs the "use"-collaborator verification scope.
5. Delivery after restart: the `ScheduleDriver` alarm admits a due run, then
   `capabilities.initiator.startHook()` → `GatekeeperHookLoopback.startHook()` →
   `OverseerDurableObject.startHook(hookId)`, which re-resolves `requireLiveHook`
   (*"Deleting or disabling the record is the authoritative kill"*) and returns
   `makeHookFiringCallback`: a proxy whose every call does
   `Reflect.apply(record.callback, ...)` against the stored persistent stub. Restoring that stub
   re-runs the coordinator's `[restore](params)`, and `onSchedule(firing)` receives
   `ScheduledFiring {scheduleId, runId, scheduledTime, actualTime, timeZone}`. The firing's
   `ApprovalQueueImpl` carries the `hookId` and revalidates the hook on every observation/action.

## Durable agent calls

`packages/workshop-backend/src/agent-spawner-binding.d.ts` declares, verbatim:

```ts
export type SpawnCallableOptions = {
  /**
   * TypeScript declarations defining the interface this agent is meant to implement, including
   * any dependencies such as interfaces of callback stubs. [...]
   * These type declarations may assume that the Workers RPC / Cap'n Web types `RpcStub` and
   * `RpcTarget` have already been imported.
   */
  types: string;
  /** Name of the interface within `types` that the agent implements. */
  mainType: string;
};

/**
 * Calls the agent. Any method name may be called; it should be one declared on the interface
 * named by `SpawnCallableOptions.mainType`. Every method resolves once the call is recorded.
 */
export type CallableAgent = { [method: string]: (...args: unknown[]) => Promise<void> };
```

Contract semantics stated in the same file: the agent *"does not start immediately"*; a call on
the returned stub *"returns a promise that resolves as soon as the call is durably queued"*;
arguments are *"encouraged to contain stubs"* which *"must be persistent (created with
`ctx.restore()`)"*; there is *"no built-in notification when the agent is done"* — define a
callback stub in the interface; and *"The returned stub can be stored in Durable Object storage
in order to invoke the same agent again in the future."*

Kernel behavior (`packages/workshop-backend/src/overseer.ts`, `src/agent.ts`):

- `AgentSpawnerBindingImpl.spawnCallable(title, options)` keeps a migration guard — a string
  second argument throws *"spawnCallable(title, prompt) has been replaced by spawnCallable(title,
  {types, mainType}); the agent no longer receives a prompt and calls no longer return values."*
- `spawnCallableAgent` → `#createSpawnedChat` freezes `spawnerConfig`, the seed `bindings`, and
  (for callable spawns) `spawnerTypes` on `AiChatAgentContext` — the declarations are *"frozen at
  spawn time like `spawnerConfig`"* and are read by the system-prompt builder without a log scan.
  No message #0 is written; the chat starts empty.
- The returned stub is `ctx.exports.AgentSelfLoopback({props: {overseerId, chatId,
  initiatorUserId, initiatorModelId}})` — the same class behind `self`. Its doc comment: *"This
  is a WorkerEntrypoint so it produces a Fetcher that can be passed over RPC and stored in
  Durable Object KV storage."*
- `deliverAgentCallback` writes a `pendingAgentCalls` record synchronously (*"The put serializes
  synchronously, so this is also where unstorable arguments are rejected"*; a `DataCloneError`
  becomes the instructive *"Arguments to a callable agent must be storable. RPC stubs must be
  persistent stubs created with ctx.restore()"*), bumps `nextAgentCallId`, schedules the alarm,
  and kicks `drainPendingAgentCalls` when the chat is idle. The drain appends `agentCallback`
  messages with a stamped `bindingName` (`<method>_ARGS`, suffixed on collision via
  `callArgsBindingName`), stores args in `agentCallbackArgs`, and starts the agent.
- Restart safety is implemented and tested: the constructor/`#resumeInterruptedAgents` and the
  alarm re-drain recorded calls (`__tests__/agent-calls.test.ts`: *"calls recorded before a
  restart are delivered when the DO is next constructed"*).
- The spawned agent's system prompt embeds the declarations: *"The Gadget expects you to
  implement the TypeScript interface `${mainType}` ... the parameters to the call will be placed
  into your `env` ... under the name given in that message"* (`src/agent.ts`).

## What the child sees

The spawned agent's env is the spawner's configured env, nothing else. `AgentSpawnerConfig.env`
is `Record<string, WorkpieceId>` (*"The bindings available to agents spawned by this spawner"*),
and `#createSpawnedChat` snapshots it: *"the spawned agent sees only these, never the workspace
default list"* — dropped entries are those whose targets no longer exist. `getEnvForAgent`
materializes each name as a governed session loopback, exactly as `getEnvForLoader` does for the
gadget facet itself: both build env entries with `makeBindingLoopback`, whose `GatekeeperLoopback`
resolves a session through `startGatekeeperSession` with the calling identity. No env entry is a
provider credential — credentials live inside the Gatekeeper DOs (the OAuth/credential-provider
split in `docs/code-mode-operator-guide.md`); the child holds typed session stubs only.

Allowlist history, stated precisely: `plans/multi-gadget.md` temporarily dropped the old flat
`env: string[]` allowlist (*"spawned agents lose allowlist support in this change (acceptable
temporary regression while in alpha)"*) and then restored it in structured form (*"Spawner env is
a `Record<name, WorkpieceId>`, required"*). The pinned kernel ships the structured form, so the
seed layer is explicit — which is what lets a coordinator profile omit provider bindings
entirely. Because the seed layer is the ceiling (*"a spawned chat's agent has no
requestConnection tool (agent.ts restricts spawned agents to describeBinding/executeCode)"*, per
the `#useScopeGatekeeperIds` comment), authority comes from the typed facade: what the child can
touch is exactly what the facade's `getTypeScriptTypes()` declares, gated by
`authorizeObservation`/the approval queue, plus whatever callback stubs the coordinator passes as
`spawnCallable` call arguments (declared in the `types` blob as `RpcStub<...>` parameters).

## Scheduler delivery semantics

- **Enablement.** Registration creates a disabled hook and returns the stable schedule ID as the
  immediate receipt; *"the schedule remains disabled and absent from `list()` until the user
  enables it in Connections"* (`packages/gatekeeper-scheduler/src/types.d.ts`). Only
  `ScheduleDriver.enable` creates driver rows, so `list()` -> `listWorkspace` cannot see
  registrations that were never enabled. Enablement quotas exist:
  `MAX_ENABLED_SCHEDULES_PER_WORKSPACE = 100` plus a per-account cap of 500
  (`schedule-driver.ts`), asserted at enable time.
- **`list()` behavior.** Returns only enabled schedules of the current workspace, after an
  observation authorization (*"List scheduled tasks"*) through the approval queue. The types doc
  warns not to use it to confirm registration: *"do not call this method in the same turn to
  confirm registration: the ID returned by the registration method is the confirmation."* Each
  successful registration is a distinct hook; *"registration is not idempotent."*
- **Delivery.** `ScheduledTaskHook.onSchedule(firing)` runs *"through the restored Gadget"* and
  does not need the Scheduler binding. Only one logical run is active per schedule; recurring
  occurrences due while a run is pending are skipped; retries reuse the same `runId`; a slot is
  consumed when due *"even if delivery then fails"*. Failures surface as
  `failureCode: "authorization_failed" | "callback_failed"` and terminal statuses
  `dead`/`completed`/`expired` on `ScheduleSummary`.
- **Cancellation.** `ScheduleSession` has exactly `every`, `calendarAt`, `runAt`, `list` — there
  is **no** session-level `cancel()`. Cancellation goes through the hook controller:
  `OverseerClientInterface.disableHook(id)` -> `record.controller.disable()` ->
  `ScheduleHookController.disable()` -> `ScheduleDriver.disable(workspaceId, scheduleId)`, which
  deletes the schedule row and its delivery capabilities. `deleteHook` and connection removal are
  the authoritative kill, and `requireLiveHook` re-checks on every firing, so a disabled hook
  stops receiving deliveries immediately even where capabilities were already issued. The
  read-only management app states the boundary: *"Enabling and disabling remain in
  Connections"* (`packages/gatekeeper-scheduler/README.md`).

## Open risks

What the seam does **not** yet prove for P4/P5:

1. **GAP: CallableAgent stub survival across a DO restart is claimed but unproven.** The `.d.ts`
   says the returned stub *"can be stored in Durable Object storage in order to invoke the same
   agent again in the future"*, and `plans/spawner-with-persistence.md` asserts *"The stub itself
   is already persistent (props are plain data), so that half needs no change."* What the kernel
   tests actually prove is narrower: `pendingAgentCalls` durability across restart
   (`agent-calls.test.ts`), while the same file concedes *"calls through the stub can't be
   exercised here"* (the test pool's RPC emulation cannot drive the `AgentSelfLoopback` proxy).
   Task 4.1 explicitly requires *"Store and invoke its callable after owner DO restart"* — this
   needs a live-workerd demonstration before P4 design commits, not just the doc claim.
2. **GAP: Nothing proves a restored hook callback can reach `spawnCallable` (or any gatekeeper
   session).** The Scheduler types doc says the restored `RpcTarget` *"does not inherit the
   Gadget's ctx"* — a firing gets only what `[restore](params)` passes. Whether a coordinator can
   open an agent-spawner session from inside `onSchedule` (the facet env being rebuilt per load
   via `getEnvForLoader`, and hook callers identified as `{from: "hook"}`) has no kernel test.
   P4's "on callback ... invoke the stored callable" depends on this path being demonstrated.
3. **GAP: No workspace-code-reachable cancellation.** `disableHook` lives on
   `OverseerClientInterface` (the Workshop owner-UI RPC) and the Connections UI; the Scheduler
   session offers no cancel, and the management app is read-only. Task 4.3's *"Runtime
   `cancelResume` fences delivery immediately and requests upstream hook disable through its
   supported management path"* can fence locally (epoch checks) but cannot request the upstream
   disable programmatically from inside the gadget — the supported path is a human action. If
   runtime-initiated cancellation is required, upstream needs a new reviewed API.
4. **No API persists a live gatekeeper session.** Sessions are opened per binding access
   (`GatekeeperLoopback` -> `startGatekeeperSession`); "retained/restored session" in Task 4.1
   must be implemented as store-the-connection-identity-and-reopen, not as holding a session
   stub across restarts.
5. **`CallableAgent` is untyped at the call site** (`{[method: string]: ...}`) and the
   declarations are frozen at spawn (`spawnerTypes` on the chat context) — changing a child
   interface means spawning a new agent. The design doc's open question about a generic
   `CallableAgent<T>` was not adopted. Related plan drift: Task 5.1 in
   `docs/superpowers/plans/2026-09-15-full-code-mode-and-gatekeepers.md` still says
   *"Use the existing `spawnCallable(title, prompt)` contract"*, while the pinned kernel serves
   `spawnCallable(title, {types, mainType})` and rejects the string form.
