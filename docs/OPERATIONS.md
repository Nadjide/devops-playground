# Running and Operating the Playground

The [README](../README.md) contains the quickstart. This guide covers
configuration, trust boundaries, cleanup, and the standalone API.

## Execution Modes

| Mode | Command | Address | Requirements |
| --- | --- | --- | --- |
| Browser demo | `npm run dev:playground` | Vite prints the URL, normally `http://127.0.0.1:5173` | Supported Node.js runtime, `npm ci` |
| Packaged demo | `npm run playground:demo` | `http://127.0.0.1:3001` | Node.js launcher, Docker + Compose, Linux containers |
| Local Docker | `npm run playground:local` | `http://127.0.0.1:3001` | Node.js launcher, Docker + Compose, Linux containers |

Use Node.js 22.22.2+ on the Node 22 line, or a compatible newer LTS version
matching [`engines.node`](../package.json).
The static demo builds with `npm run build:playground` and can be served from
`apps/web/dist`. It needs no backend. Public hosting is a separate owner decision.

`PLAYGROUND_PORT` chooses another loopback port for packaged modes:

```powershell
$env:PLAYGROUND_PORT = '3002'
npm run playground:local
```

```bash
PLAYGROUND_PORT=3002 npm run playground:local
```

## Lifecycle and Cleanup

```bash
npm run playground:status
npm run playground:down
npm run playground:cleanup
```

`down` ends sessions, removes their owned lab resources, stops the portal and
runner, and reports leftovers. `cleanup` removes this installation's orphaned
resources after an interruption. Neither is a general Docker cleanup command.
Foreign containers, images, and networks are not a deletion target.

Reset creates a clean generation. Provider changes create a new session without
carrying evidence or emulator data forward. Both emulators use in-memory data;
restarting an emulator empties it.

## Trust Boundaries

- The Docker socket gives the runner control of the host daemon. Use a trusted
  personal machine, not an Internet-facing shared installation.
- The portal binds to `127.0.0.1`, runs non-root, and mounts no socket.
- The private runner requires a per-launch token and publishes no host ports.
- Management writes require same-origin checks and a CSRF token.
- Workloads use non-root containers, read-only root filesystems, internal
  networks, dropped capabilities, and bounded CPU, memory, processes, and output.
- The terminal accepts a bounded command grammar, not arbitrary shell commands.
- Storage adapters use explicit emulator endpoints and test credentials,
  never ambient cloud identities. Only S3 and Blob storage are supported.

Tested versions, endpoint validation, authentication, and storage limits are
documented in the [runner guide](../apps/runner/README.md).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Docker daemon unavailable | Start Docker Desktop or Docker Engine, then rerun the launcher |
| `DOCKER_PERMISSION_DENIED` | Restart with `npm run playground:local` to detect the socket group |
| `DOCKER_CONTEXT_UNSUPPORTED` | Switch to local Linux containers |
| Port 3001 is occupied | Stop the other process or set `PLAYGROUND_PORT` |
| First session is slow | The approved workload image is building; later sessions reuse it |
| Image build or emulator pull fails | Check network access to the public registries, then retry |
| Health probe returns `ECONNREFUSED` | Inspect stopped state, listening port, and crash logs; it may be the mission incident |
| Reconnecting appears | The event stream dropped; it resumes or refreshes the snapshot automatically |
| Demo checkpoint cannot be restored | Use Discard saved progress or Continue without saving in the banner |
| Controller restarts with a local lab remaining | Recover the label-verified session through the workbench or choose cleanup |
| Owned resources remain after an interruption | Run `playground:status`, then `playground:cleanup` |

Stopped services, wrong ports, and broken releases are expected lab incidents.
Local Docker never silently switches to simulation when a dependency fails.

## Original API

The standalone Express API uses **port 3000**, the interactive portal port 3001.
Choose one startup alternative at a time:

```bash
npm start
```

```bash
docker build -t devops-playground .
docker run --rm -p 3000:3000 devops-playground
```

```bash
docker compose up --build
# In another terminal:
curl http://localhost:3000/health
docker compose down
```

### GET /

```json
{ "message": "DevOps Playground API is running" }
```

### GET /health

```json
{
  "status": "ok",
  "service": "devops-playground",
  "uptime": 12.345,
  "timestamp": "2026-11-05T10:00:00.000Z"
}
```

Uptime and timestamp are runtime observations; these values are examples.

### GET /version

```json
{
  "name": "devops-playground",
  "version": "1.0.0",
  "environment": "development"
}
```

`PORT` defaults to 3000; `NODE_ENV` defaults to `development`.
Docker sets `NODE_ENV=production`. Run `npm test` or `npm run test:ci` for
the original Jest + Supertest suite.
