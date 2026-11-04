# Playground Domain Foundations

`@devops-playground/lab-core` provides the shared JavaScript contracts and pure
session state transitions used by the future workbench and local controller.
Its source has no Node-specific imports and can run in a browser.

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
| `containerObservationSchema` | Lifecycle, health, ports, image, time, and source |
| `sessionSchema` | Versioned snapshot with ownership and reference checks |
| `eventSchema` | Typed event envelope and payload with canonical event ID |
| `missionProgressSchema` | Objective status and evidence representation |
| `objectiveEvidenceSchema` | Generation, revision, source, and observation evidence |
| `operationTypeSchema` | Initial supported operation names |
| `createSession` | Build an initial session from a validated lab manifest |
| `reduceSession` | Apply one validated, ordered domain event without mutation |
| `replaceSessionSnapshot` | Recover from event gaps or controller epoch changes |
| `SessionStateError` | Transition error with a machine-readable `code` |

Schemas reject unexpected fields. They validate structural contracts.
Fixture lookup, allowed-operation authorization, execution, mission predicate
evaluation, and scheduling belong to the subsequent lots in the master plan.

## Deterministic Inputs

`createSession` accepts `manifest`, `mode`, `resources`, `now`, and `nextId`.
The injected `now` function returns an ISO UTC timestamp.
`nextId` returns a safe identifier, first for the session and then for its event
epoch. Default implementations use the current time and Web Crypto UUIDs.

When supplying initial resources, their session ID and generation must match the
created session. Tests inject known IDs and clocks to verify this contract.

## Event Ordering

Each accepted event advances revision and sequence by exactly one.
Canonical IDs have the shape `sessionId:eventEpoch:sequence`.
Replayed events and results from an older generation or epoch return the original
snapshot unchanged. Missing events, future generations, foreign sessions,
invalid transitions, and unknown resources raise typed errors.

The current event set covers session status, session reset, resource observation,
and operation lifecycle. Subsequent lots add their event types with their tests.
Resource observations merge only the fields allowed by the observation schema.

Reset requires a prepared resetting state and reconciled operations, advances
generation, clears operation history, and restores fresh mission progress.
An explicit snapshot replacement handles a new controller epoch.
Replacement validates identity, generation, and freshness before accepting it.

## Compatibility

The root workload remains CommonJS. This workspace uses its own ESM boundary.
The standalone workload image installs only root production dependencies with
`npm ci --omit=dev --workspaces=false`.

See the [master plan](../../DEVOPS_PLAYGROUND_MASTER_PLAN.md) for delivery scope,
future execution adapters, and the per-lot PR protocol.
