# Playground Workbench

`@devops-playground/web` is the React and Vite workbench for DevOps Playground.
The production build is a static site that opens directly in Demo mode and
needs no backend, Docker daemon, cloud account, or secret.

## Commands

Run these from the repository root after `npm ci`.

| Command | Purpose |
| --- | --- |
| `npm run dev:playground` | Start the Vite dev server and print its local URL (default `http://127.0.0.1:5173`) |
| `npm run build:playground` | Build the static workbench into `apps/web/dist` |
| `npm run test:web` | Run the Vitest and Testing Library suite |
| `npm run test:e2e:demo` | Build, serve the static output, and run the Playwright demo suite |

The Playwright suite blocks every request outside the preview origin and fails
if the workbench tries to reach a backend.

## Structure

| Path | Responsibility |
| --- | --- |
| `src/session/` | Session client boundary: snapshots, subscriptions, operation dispatch |
| `src/components/` | Chrome, mission sidebar, accessible tabs, layout, shared controls |
| `src/panels/` | Docker, Cloud, Monitoring, Logs, Events, Terminal, and Pipeline panels |
| `src/styles/` | Design tokens and plain CSS for the workbench |

Panels read the shared session snapshot through `useSessionState()` and request
work through the session client. They never keep their own copy of resource
truth.

## Session Client Contract

| Member | Contract |
| --- | --- |
| `getSnapshot()` | Returns `{ status, connection, session, events, error }` |
| `subscribe(listener)` | Registers a change listener and returns its unsubscribe function |
| `dispatch(request)` | Requests a typed operation and resolves with the operation |
| `isAvailable(type)` | Reports whether the active backend supports an operation type |
| `capabilities` | Mode, provenance source, and backend label for the chrome |

Unsupported operations reject with `CAPABILITY_UNAVAILABLE` and the UI renders
them as unavailable controls with an explanation.

## Cloud Panel

Storage labs show the provider, backend, approved endpoint, and source of every
result. The panel configures the service's bucket, runs the service storage
check, creates and deletes buckets (deletion asks for confirmation), and
writes, lists, reads, and deletes text objects. Labs without storage show an
explanation instead. In the terminal, `aws s3 ls|mb|cp ... -|rm` and
`curl http://api:3000/storage-check` map to the same operations.

## Terminal and Logs

The Terminal panel is an xterm view over the workbench command grammar defined
in `lab-core` (`parseCommand`). It is not a shell: commands such as
`docker start api` or `curl http://api:3000/health` become the same typed
operations the buttons dispatch. Shell operators, substitutions, redirects,
globs, environment assignments, unknown flags, arbitrary URLs, unapproved
ports, multiline input, and inputs over 512 characters are rejected with
guidance. `lab reset` opens the same confirmation dialog as the session menu.
History keeps the last 100 commands; `clear` only clears the view. xterm is
loaded lazily in its own chunk.

The Logs panel reads the selected service's logs when it opens (that read is
the diagnostic evidence), supports pausing autoscroll and clearing the visible
view without deleting domain logs, and shows a truncation notice when the
500-entry / 256 KiB retention bound discards older lines. Log text is sanitized
at ingestion and always rendered as text. The Events panel lists orchestration
events separately from workload logs.

## Pipeline

The Pipeline panel shows the fixed stage graph (validate, test, build, deploy,
verify) for the latest run, per-stage logs, exit codes, and durations, the
deployed release with its verification status, the last known-good release,
and the run history. Runs deploy an approved candidate; rollback recreates the
known-good release and verifies health and version. Cancel is offered only
before deploy changes the service. The panel is labeled Simulated pipeline in
Demo mode and stays distinct from the repository GitHub Actions workflow.

## Saved Progress

The demo saves a versioned checkpoint (`devops-playground:demo-checkpoint:v1`,
at most 512 KiB) in local storage shortly after each change and when the page is
hidden. Layout preferences (selected tabs, panel sizes) live under a separate
key. On reload the session is validated and hydrated: work that was running is
reconciled as cancelled, an interrupted start is reported as stopped, and
objectives are re-evaluated. Corrupt, incompatible, or oversized saved progress
starts a fresh session and offers an explicit choice to discard it or continue
without saving. Denied storage or a full quota only disables saving. Observation
ages are shown and marked stale after 30 seconds.

`npm run build:playground` writes the static site to `apps/web/dist`; any
static file server can host it, and `npm run preview --workspace @devops-playground/web`
serves it locally on `http://127.0.0.1:4173`.

## Layout

At widths of 1024 px and above the workbench uses a mission sidebar, two
resizable work areas, and a collapsible terminal/events drawer. Separators
support keyboard resizing; `Ctrl+\`` toggles the drawer. Narrower viewports
switch to a single scrollable tab list with stacked content.
