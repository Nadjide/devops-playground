# Lab Manifests

Each directory holds one validated lab manifest. Manifests are data only:
fixture and predicate identifiers resolve through explicit registries in
`packages/lab-core` and never select file paths or execute code.

| Lab | Kind | Fixture | Outcome |
| --- | --- | --- | --- |
| `stopped-container` | Mission M01 | `api-stopped` | Read evidence, start the API, verify a fresh `/health` |
| `wrong-port` | Mission M02 | `api-wrong-port` | Find the port mismatch, apply `appPort` 3000, verify health on port 3000 |
| `broken-release` | Mission M03 | `api-broken-release` | Inspect the failed 1.1.0 release, roll back, verify version 1.0.0 and health |
| `storage-provision` | Mission M04 (AWS S3) | `s3-unprovisioned` | Create the bucket the service expects, write and read an object, verify the service round trip |
| `blob-provision` | Mission M04 (Azure Blob) | `blob-unprovisioned` | The same outcome with a container and a blob |
| `storage-config` | Mission M05 (AWS S3) | `s3-misconfigured` | Find the misspelled bucket, point the service at the bucket that holds its data, verify a fresh round trip |
| `blob-config` | Mission M05 (Azure Blob) | `blob-misconfigured` | The same outcome with a misspelled container |
| `free-exploration` | Exploration | `api-running` (also `api-stopped`, `api-wrong-port`, `api-broken-release`) | Operate the API and the pipeline without objectives |

## Manifest Fields

| Field | Contract |
| --- | --- |
| `kind` | `mission` (default) or `exploration`; exploration has no objectives |
| `fixtureId` / `fixtureOptions` | Default and approved starting fixtures from the fixture registry |
| `allowedOperations` | Operation types the lab accepts; anything else returns `OPERATION_NOT_ALLOWED` |
| `objectives[].predicateId` | One of `evidence.logs-read`, `service.running`, `service.health-verified`, `service.expected-port`, `service.version-verified`, `storage.namespace-ready`, `storage.object-read-back`, `storage.workload-configured`, `storage.roundtrip-verified` |
| `hints` | Up to five hints revealed one at a time on request |
| `variant` | Optional `{ group, provider }`: provider variants of one learning outcome; the fixture must use that provider |
| `solution` | Steps shown only after an explicit, confirmed request |

## Evaluation Rules

- Predicates read the current snapshot after every event, whichever control caused it.
- Reading logs or an inspect result is evidence that stays valid for the generation.
- Health and version evidence must come from the current process and be at most
  10 seconds old when it first satisfies an objective.
- A mission completes when every required objective holds at the same revision.
  The completion record stays even if the service later degrades.
- Reset starts a new generation with pending objectives.
- Storage connectivity requires a fresh workload round trip from the current
  process; console listings or reads never satisfy it.
- The S3 storage labs run in Demo mode and against a session-owned Moto
  emulator in Local Docker mode; the Azure Blob labs run in Demo mode. Their
  fixtures include a namespace owned by another team that stays read-only.
- Provider variants keep their own wording, hints, solutions, naming rules, and
  errors. Switching provider always starts a new session.

Workbench catalogs list only labs whose operations the active backend implements.
