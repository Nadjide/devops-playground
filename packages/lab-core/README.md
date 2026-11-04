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
| `storageStateSchema` | Session storage: provider, approved endpoint, namespaces, object metadata, round-trip records |
| `getStorageProvider` | Provider profile: terminology, naming rules, approved endpoint, provider errors |
| `parseCheckpoint` / `serializeCheckpoint` | Versioned browser checkpoints with deliberate migrations |

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

## Cloud Storage

Storage labs share the session model. The session snapshot (schema version 2)
carries `storage`, which is `null` for core labs. Operations are limited to the
shared mission surface:

| Operation | Effect |
| --- | --- |
| `storage.namespace.create` / `list` / `delete` | Bucket (S3) or container (Azure Blob) lifecycle; deletion needs lab ownership; S3 refuses non-empty buckets while Azure deletes a container with its blobs |
| `storage.object.put` / `list` / `get` / `delete` | UTF-8 text objects, at most 64 KiB, flat keys only |
| `storage.configure` | Point the workload at a namespace; only the session emulator endpoint is approved |
| `storage.roundtrip.verify` | The workload writes a payload through its own configuration and reads it back |

Provider profiles keep their own vocabulary and errors: S3 (`NoSuchBucket`,
`BucketNotEmpty`, `InvalidBucketName`; deleting a missing key succeeds) and
Azure Blob (`ContainerNotFound`, `BlobNotFound`, `InvalidResourceName`;
deleting a missing blob fails). The approved endpoints are `http://storage:5000`
and `http://storage:10000/devstoreaccount1`. Namespace names, endpoints, and
ownership are checked before any backend call. Sessions hold at most 8
namespaces and 50 objects; the simulator keeps object text in the snapshot
within a 128 KiB budget so checkpoints stay below 512 KiB, and reads return a
4 KiB preview with the size and SHA-256 of the whole object.

The objective predicates `storage.namespace-ready`, `storage.object-read-back`,
`storage.workload-configured`, and `storage.roundtrip-verified` read the same
snapshot. Only a workload round trip proves connectivity: listing or reading an
object from the console never satisfies it.

Checkpoint version 2 adds storage. Version 1 checkpoints migrate by adding an
empty storage state; a version 1 session that already carries storage is
rejected as invalid.

## Compatibility

The root workload remains CommonJS. This workspace uses its own ESM boundary.
The standalone workload image installs only root production dependencies with
`npm ci --omit=dev --workspaces=false`.

See the [master plan](../../DEVOPS_PLAYGROUND_MASTER_PLAN.md) for delivery scope,
future execution adapters, and the per-lot PR protocol.
