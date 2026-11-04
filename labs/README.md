# Lab Manifests

Each directory holds one validated lab manifest. Manifests are data only:
fixture and predicate identifiers resolve through explicit registries in
`packages/lab-core` and never select file paths or execute code.

| Lab | Kind | Fixture | Outcome |
| --- | --- | --- | --- |
| `stopped-container` | Mission M01 | `api-stopped` | Read evidence, start the API, verify a fresh `/health` |
| `wrong-port` | Mission M02 | `api-wrong-port` | Find the port mismatch, apply `appPort` 3000, verify health on port 3000 |
| `broken-release` | Mission M03 | `api-broken-release` | Inspect the failed 1.1.0 release, roll back, verify version 1.0.0 and health |
| `free-exploration` | Exploration | `api-running` (also `api-stopped`, `api-wrong-port`, `api-broken-release`) | Operate the API and the pipeline without objectives |

## Manifest Fields

| Field | Contract |
| --- | --- |
| `kind` | `mission` (default) or `exploration`; exploration has no objectives |
| `fixtureId` / `fixtureOptions` | Default and approved starting fixtures from the fixture registry |
| `allowedOperations` | Operation types the lab accepts; anything else returns `OPERATION_NOT_ALLOWED` |
| `objectives[].predicateId` | One of `evidence.logs-read`, `service.running`, `service.health-verified`, `service.expected-port`, `service.version-verified` |
| `hints` | Up to five hints revealed one at a time on request |
| `solution` | Steps shown only after an explicit, confirmed request |

## Evaluation Rules

- Predicates read the current snapshot after every event, whichever control caused it.
- Reading logs or an inspect result is evidence that stays valid for the generation.
- Health and version evidence must come from the current process and be at most
  10 seconds old when it first satisfies an objective.
- A mission completes when every required objective holds at the same revision.
  The completion record stays even if the service later degrades.
- Reset starts a new generation with pending objectives.

Workbench catalogs list only labs whose operations the active backend implements.
