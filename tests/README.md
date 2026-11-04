# Verification Matrix

Every suite states what it actually exercises. Simulated results never stand
in for Docker results, and a mocked test never claims that an image builds.

| Command | Scope | Execution | Runs in CI job |
| --- | --- | --- | --- |
| `npm test` / `npm run test:ci` | Original API routes (Jest, Supertest) | In-process Express | Test |
| `npm run test:core` | Schemas, reducer, runtime, simulator, parser, missions, pipeline, checkpoints and migration, simulated S3 and Azure Blob storage | Node, virtual clock | Test |
| `npm run test:web` | Workbench components, demo and local clients, terminal, persistence | jsdom, virtual clock, fake xterm | Test |
| `npm run test:control` | Same-origin, CSRF, ownership, idempotency, SSE, recovery, runner stream | In-process Express, fake runner | Test |
| `npm run test:runner` | Token, browser-origin refusal, diagnostics, probes, observations, ownership, metrics | In-process Express, fake Docker | Test |
| `npm run test:e2e:demo` | Five viewports, all missions including the S3 and Azure Blob storage missions and provider switching, terminal, pipeline, persistence and checkpoint migration, recovery, keyboard-only | Static build in Chromium, backend traffic blocked | Demo E2E |
| `node scripts/check-playground-stack.js demo\|local` | Packaged boundaries: bindings, mounts, runner token, isolation | Real Compose stack | Playground stack |
| `npm run test:integration:local` | M01-M03, real pipeline, controller crash recovery, runner outage, stress, security regressions | Real Docker daemon via the packaged portal | Playground stack |
| `npm run test:e2e:local` | M01-M03 and the S3 provisioning mission in the browser, runner outage, phone layout | Chromium against real Docker and Moto | Playground stack |
| `npm run test:integration:cloud` | S3 M04 and M05 with the workload round trip, endpoint and ownership refusals, emulator outage and reset, cleanup | Session-owned Moto 5.2.5 and the storage workload on real Docker | Cloud emulators |
| Docker job | Original image and Compose healthcheck | Real Docker | Docker |

## Viewports

Demo suites check 1440x900, 1024x768, 768x1024, 390x844, and 320 px wide with a
horizontal-overflow assertion. Local suites check desktop and a 390 px phone.

## Running Locally

The local suites start and stop the packaged stack themselves and require Docker
Desktop or Docker Engine with Linux containers.

```bash
npm run test:playground
npm run test:e2e:demo
npm run test:integration:local
npm run test:e2e:local
```

Failure artifacts (screenshots, traces, reports) are written to `test-results`
and `playwright-report`, which are ignored by Git and uploaded by CI.
