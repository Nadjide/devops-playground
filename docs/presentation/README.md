# Presentation Sources

The README uses the running application, with browser simulation and actual
local Docker evidence identified separately.

## Media Inventory

| Asset | Source and execution mode |
| --- | --- |
| [Walkthrough](../demo/devops-playground.mp4) | Browser recording of the static **simulator**, 1600 x 1000, H.264, no audio, four chapters |
| [README preview](../demo/devops-playground.gif) | Four five-second excerpts from the recording, 960px wide, 6 fps |
| [Recording metadata](../demo/recording.json) | Source commit, mode, viewport, duration, chapters, backend-request count |
| `demo-mission-complete.png` | Simulated API recovery, health/version, terminal, completed objectives |
| `demo-broken-release-pipeline.png`, `demo-pipeline-recovered.png` | Failed candidate verification and successful simulated rollback |
| `demo-s3-storage.png`, `demo-azure-storage.png` | Provider-specific simulated operations and workload round trips |
| `demo-mobile-cloud.png` | Azure simulation at a 390 x 844 mobile viewport |
| `local-docker-rollback.png` | Actual Docker acceptance capture from L13 |
| `local-azure-storage.png` | Actual Azurite capture from L17 acceptance; its application tree matches merged commit `40f0098` |

All PNGs are in [`docs/screenshots`](../screenshots). Payloads are illustrative
text. The Azurite development account and internal endpoints shown are public
local-emulator settings, not subscription credentials.

The video shows the browser simulator throughout. It is not a recording of
cloud services or a claim about deployment speed. No application state, UI,
or API response has been substituted. The application implements the labeled
simulation. The GIF removes time between excerpts without changing their speed.

## Regenerate the Demo

Use the repository's supported Node.js runtime, Playwright Chromium, and
`ffmpeg` / `ffprobe` on `PATH`. No encoding dependency is added to the project.

From the repository root:

```bash
npm ci
npx playwright install chromium
npm run build:playground
node scripts/capture-presentation.mjs
node scripts/encode-presentation.mjs
```

On Linux, use `npx playwright install --with-deps chromium` if its system
libraries are missing.

The capture script owns a preview on `127.0.0.1:4188`. It refuses an occupied
port, uses a new browser profile, drives ordinary workbench actions, asserts
completed missions, and stops its preview. It does not start Docker or use an
existing local session. Backend requests and browser errors fail the recording.

Raw WebM and capture metadata stay in ignored `test-results/presentation`.
The encoder writes the publishable MP4, GIF, and metadata to `docs/demo`,
preserving playback speed and adding MP4 chapters. Runtime timestamps and
timings can change; these media are not snapshot tests.

## Actual Local Evidence

The real Docker captures are retained from core and L17 acceptance. They were
not regenerated while another agent reviewed the shared Docker environment.
They show actual workbench operations and have not been composited or edited.

To refresh the real rollback capture, coordinate access to the single-user
Docker stack first:

```bash
npm run playground:local
node scripts/capture-screenshots.mjs local
```

The capture command uses and changes the session on the running port 3001
stack. L17 Azure desktop/mobile captures are also produced by the storage
cases in `npm run test:e2e:local`, under `test-results/playwright`.
Never run local integration or browser suites concurrently against this stack.
