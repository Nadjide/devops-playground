# Playground Domain Foundations

`@devops-playground/lab-core` provides the shared JavaScript contracts, the
pure session reducer, the lab runtime, and the deterministic simulator used by
the workbench and the local controller. Its source has no Node-specific
imports and runs in a browser.

## Run Checks

From the repository root, install with `npm ci`, then run these commands.

```bash
npm run lint
npm run test:core
npm run test:playground
```

The root Jest suite runs separately through `npm test` and `npm run test:ci`.
Each test runner has an explicit discovery scope.

## Public API

| Export | Contract |
| --- | --- |
| `labManifestSchema` | Strict lab metadata, operations, and objective definitions |
| `operationRequestSchema` | Discriminated operation type and approved parameters |
| `operationSchema` | Owned operation identity and lifecycle timestamps/results |
| `resourceSchema` | Owned container configuration and observed runtime facts |
| `sessionSchema` | Versioned snapshot with ownership, bounded probes, and bounded logs |
| `eventSchema` | Typed event envelope and payload with canonical event ID |
| `probeObservationSchema` | Structured health/version probe result with a 16 KiB body bound |
| `logLineSchema` | One workload or system log line, at most 8 KiB |
| `createSession` | Build an initial session from a validated lab manifest |
| `reduceSession` | Apply one validated, ordered domain event without mutation |
| `replaceSessionSnapshot` | Recover from event gaps or controller epoch changes |
| `createLabRuntime` | Own one session: validation, queueing, idempotency, reset, end |
| `createSimulatorExecutor` | Deterministic browser Docker model for Demo mode |
| `createSystemClock` / `createVirtualClock` | Wall clock and test clock with `advance` |
| `DomainError` / `OperationFailure` | Typed request rejection and execution failure |
| `labCatalog` / `getLabManifest` | Validated manifests loaded from `labs/` |
| `getFixture` / `getRelease` | Approved fixtures and workload images |

## Deterministic Inputs

`createSession` and `createLabRuntime` accept injected `now`/`clock` and
`nextId` functions. Tests use `createVirtualClock`, which only moves time
through `advance(ms)` or `runAll()`, so no test sleeps.

## Event Ordering

Each accepted event advances revision and sequence by exactly one.
Canonical IDs have the shape `sessionId:eventEpoch:sequence`.
Replayed events and results from an older generation or epoch return the original
snapshot unchanged. Missing events, future generations, foreign sessions,
invalid transitions, and unknown resources raise typed errors.

Event types cover session status and reset, resource observations, probe
results, log batches, and operation lifecycle. Reset requires a prepared
resetting state and reconciled operations, advances generation, clears
operations, probes, and logs, and restores fresh mission progress.

## Lab Runtime

`createLabRuntime({ labId, mode, executor, clock, nextId })` returns an object
with `start()`, `submit(request, { idempotencyKey })`, `getSession()`,
`getEvents()`, `getOperation(id)`, `settled(id)`, `subscribe(listener)`, and
`dispose()`.

| Rule | Behavior |
| --- | --- |
| Validation | Malformed requests `400`, disallowed operations `422`, unknown services `404`, stale generation `409` |
| Idempotency | Identical retry returns the original operation; a different payload returns `409` |
| Serialization | Mutations run one at a time; inspect, logs, and probes run concurrently |
| Capacity | 10 pending mutations and 10 active reads; excess returns `429` |
| Retention | 1,000 events, 100 completed operations, 20 probes, 500 log entries / 256 KiB, 256 idempotency keys |
| Reset | Cancels queued work, aborts running work, drops older-generation timers, recreates the fixture in a new generation |
| End | Cancels work, tears down resources, and refuses further operations |

Executors implement `setup`, `execute`, and `teardown` and report every effect
through the runtime context (`emit`, `emitLogs`, `delay`, `later`). The browser
simulator reports `simulator` provenance; real drivers use `docker`, `probe`,
or `emulator`.

## Compatibility

The root workload remains CommonJS. This workspace uses its own ESM boundary.
The standalone workload image installs only root production dependencies with
`npm ci --omit=dev --workspaces=false`.

See the [master plan](../../DEVOPS_PLAYGROUND_MASTER_PLAN.md) for delivery scope,
future execution adapters, and the per-lot PR protocol.
