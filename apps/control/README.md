# Playground Control API

`@devops-playground/control` serves the built workbench and the management API
from one loopback origin. It owns local session state, applies the shared lab
runtime, and talks to the internal runner. It never mounts the Docker socket.

## Routes

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/health` | Management process health (never workload health) |
| GET | `/api/capabilities` | Mode, runner status, Docker diagnostics, runnable labs |
| GET | `/api/labs` | Labs the local backend can run |
| GET | `/api/security/csrf` | CSRF token bound to the browser session cookie |
| POST | `/api/sessions` | Create the local session (`labId`, optional `fixtureId`) |
| GET | `/api/sessions/:id` | Fresh snapshot for the owning browser |
| POST | `/api/sessions/:id/operations` | Validate and enqueue a typed operation (`202`) |
| GET | `/api/sessions/:id/operations/:operationId` | Operation status and result |
| GET | `/api/sessions/:id/events` | Server-Sent Events with `Last-Event-ID` replay |
| GET | `/api/sessions/:id/metrics` | Measured CPU and memory of the session workloads |
| POST | `/api/recovery/:sessionId` | After a controller restart: `recover` or `cleanup` owned resources |

## Trust Boundaries

- The `Host` header must name the configured loopback portal; anything else is
  rejected with `403 HOST_REJECTED` (DNS rebinding defence).
- Mutations require an allowed `Origin`, the `pg_session` cookie
  (`HttpOnly; SameSite=Strict`), and an `X-CSRF-Token` bound to that cookie.
  Foreign-origin reads and cross-site fetches are rejected; no CORS headers are sent.
- Sessions belong to the browser session that created them: other browsers get
  `404` on reads, operations, and event streams.
- Request bodies are limited to 64 KiB; one local session can be active.
- Errors use the section 11.3 envelope. Unexpected failures return a safe
  message with a correlation ID that matches the server log.
- SSE replays only events after a valid cursor of the current epoch. Unknown,
  evicted, or foreign-epoch cursors receive `snapshot.required`. Heartbeats run
  every 15 seconds and slow subscribers are disconnected above 1 MiB buffered.

## Restart Recovery

On start, capabilities list sessions whose label-verified resources this
installation still owns. `recover` re-observes them and adopts the session
with its original ID and generation, a new event epoch, and unverified
objectives; earlier SSE cursors receive `snapshot.required`. `cleanup` removes
only that session's owned resources. On `SIGTERM` the controller ends open
sessions before exiting, so `playground:down` normally leaves nothing behind.

In Demo mode the portal serves the browser simulation and every session route
answers `503 LOCAL_MODE_UNAVAILABLE`. In Local mode, a session is created only
when the runner and the Docker daemon both answer; there is no simulated fallback.

```bash
npm run test:control
```
