# Playground Runner

`@devops-playground/runner` is the only service with access to the Docker
daemon socket. It runs on the private `management` Compose network, publishes
no host port, and accepts only authenticated requests from the controller.

Docker socket access is equivalent to control of the host daemon. Resource
labels and request validation are application safeguards, not a sandbox: the
local mode is meant for a trusted owner operating their own Docker installation.

## Authentication

- The launcher generates a 256-bit token per launch and passes it to the
  controller and runner through their process environment only.
- Requests need `Authorization: Bearer <token>`; the comparison is timing safe.
- Requests carrying a browser `Origin` or `Sec-Fetch-Site` header are refused.

## Routes

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/v1/health` | Runner process health |
| GET | `/v1/docker` | Daemon version and API diagnostics, or a typed failure |
| POST | `/v1/sessions/:id/setup` | Build or reuse the approved image, create the session network and workload (NDJSON) |
| POST | `/v1/sessions/:id/execute` | Perform one validated operation and stream observations (NDJSON) |
| POST | `/v1/sessions/:id/teardown` | Remove the session's owned containers and networks (NDJSON) |

## Workloads

The approved fixture lives in `labs/fixtures/api` and is built through the
Engine API from an allowlisted context (Dockerfile, package.json, server.js,
tests). Build arguments come only from the release catalog. Every container and
network carries `devops-playground.managed`, `.installation`, `.session`,
`.generation`, and `.lab` labels, which are re-verified on the inspected object
before each mutation. Workloads run as a non-root user with a read-only root
filesystem, CPU, memory, and process limits, no capabilities, no published
ports, and an internal per-session network. Probes use the fixed service alias
and the lab's expected port only.

## Storage Emulators

Storage labs start one emulator per session generation, only when the selected
lab needs it; core labs never pull or start one.

| Provider | Emulator | Image | Exercised API |
| --- | --- | --- | --- |
| AWS S3 | Moto 5.2.5 in server mode | `motoserver/moto:5.2.5@sha256:59a1965d…` (pinned by digest) | ListBuckets, CreateBucket, DeleteBucket, Put/GetBucketTagging, PutObject, GetObject, ListObjectsV2, DeleteObject |

The emulator joins the session's internal network as `storage`, publishes no
port, and runs as `65534:65534` with a read-only root filesystem, a 32 MiB
`/tmp`, no capabilities, `no-new-privileges`, 256 MiB, 0.5 CPU, and 128
processes. It carries the same ownership labels as the workload with the role
`emulator`, so teardown and `playground:cleanup` remove it with the session.
Moto keeps data in memory: ending or resetting the session removes it, and a
restarted emulator is re-observed as empty.

The runner reaches it through `@aws-sdk/client-s3` 3.1159.0 with the endpoint
`http://storage:5000`, region `us-east-1`, path-style addressing, and the fixed
test credentials `testing`/`testing`. The endpoint is checked before a client
is created, and explicit credentials, region, and endpoint mean environment
variables, shared profiles, and instance metadata are never consulted.
Namespaces are tagged `devops-playground-owner=lab`; anything else is read-only.

The storage workload (`labs/fixtures/storage-api`) has no dependencies: it signs
S3 requests with Signature Version 4 through `node:crypto`. Its `/storage-check`
writes a fresh payload through its configured target, reads it back, and
answers `200` with matching SHA-256 digests or `503` with the provider error;
the runner validates that response before it becomes evidence.

## Pipeline

`pipeline.run` deploys an approved candidate from the fixture catalog and
`pipeline.rollback` recreates the recorded known-good release. Stages run with
fixed inputs: the test stage copies the allowlisted fixture files into a
disposable networkless container and runs `npm test`; the build stage builds
the approved image; deploy replaces the owned workload; verify probes health
and version for up to 60 seconds. Stage logs, exit codes, and durations are
recorded through the shared pipeline recorder, and closing the stream cancels
the run before deploy.

Daemon failures map to `DOCKER_UNAVAILABLE`, `DOCKER_PERMISSION_DENIED`,
`DOCKER_CONTEXT_UNSUPPORTED` (Windows containers), or `DOCKER_ERROR`, with
actionable messages that never include secrets.

## Docker Compatibility

The runner uses `dockerode` against the Engine API negotiated by the daemon.
Verified with Docker Engine 29.7.2 (API 1.55) on Docker Desktop for Windows and
with the Ubuntu runner Engine in GitHub Actions. Image builds in later lots use
the Engine API through `dockerode`, so the runner image needs no Docker CLI.

```bash
npm run test:runner
```
