import tar from 'tar-fs';
import {
  createPipelineRecorder, createRunRecord, getFixture, getReleaseById, releaseRef,
} from '@devops-playground/lab-core';
import { ensureReleaseImage, FIXTURE_DIR, FIXTURE_FILES } from './images.js';
import { LABELS, ownershipLabels, resourceName } from './labels.js';
import { demultiplex } from './observe.js';
import { DriverFailure, WORKLOAD_LIMITS } from './lab-driver.js';

export const PIPELINE_LIMITS = Object.freeze({
  testMs: 5 * 60_000,
  verifyMs: 60_000,
  verifyIntervalMs: 2000,
  logLines: 38,
  testImage: 'node:22-alpine',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cancelled extends Error {}

function tailLines(lines, limit = PIPELINE_LIMITS.logLines) {
  return lines.length <= limit ? lines : lines.slice(-limit);
}

/**
 * Real delivery chain over the approved fixture: validate, test in a
 * disposable networkless container, build through the Engine API, deploy by
 * replacing the owned workload, and verify health and version with a deadline.
 * Commands and inputs are fixed; nothing comes from the browser.
 */
export function createPipelineExecutor({ docker, installationId, driver, limits = PIPELINE_LIMITS }) {
  async function ensureTestImage() {
    try {
      await docker.getImage(limits.testImage).inspect();
    } catch (error) {
      if (error?.statusCode !== 404) {
        throw error;
      }
      const stream = await docker.pull(limits.testImage);
      await new Promise((resolve, reject) => docker.modem.followProgress(stream, (failure) => (failure ? reject(failure) : resolve())));
    }
  }

  async function runTests({ session, release, isCancelled }) {
    await ensureTestImage();
    const name = resourceName(session.id, session.generation, `test-${Date.now().toString(36)}`);
    const container = await docker.createContainer({
      name,
      Image: limits.testImage,
      Cmd: ['npm', 'test', '--silent'],
      WorkingDir: '/home/node',
      User: 'node',
      Env: [`APP_VERSION=${release.version}`, 'NODE_ENV=test'],
      Labels: {
        ...ownershipLabels({ installationId, sessionId: session.id, generation: session.generation, labId: session.labId, fixtureId: session.fixtureId }),
        [LABELS.role]: 'pipeline-test',
      },
      HostConfig: {
        NetworkMode: 'none',
        Memory: WORKLOAD_LIMITS.memoryBytes,
        NanoCpus: WORKLOAD_LIMITS.nanoCpus,
        PidsLimit: WORKLOAD_LIMITS.pids,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
      },
    });
    try {
      // Only the allowlisted fixture files are copied; no Git metadata, env files, or modules.
      await container.putArchive(tar.pack(FIXTURE_DIR, { entries: [...FIXTURE_FILES] }), { path: '/home/node' });
      const started = Date.now();
      await container.start();
      let info = await container.inspect();
      while (info.State.Running) {
        if (isCancelled()) {
          throw new Cancelled();
        }
        if (Date.now() - started > limits.testMs) {
          await container.kill().catch(() => {});
          throw new DriverFailure('TEST_TIMEOUT', `Tests exceeded ${limits.testMs / 60_000} minutes.`);
        }
        await sleep(250);
        info = await container.inspect();
      }
      const raw = await container.logs({ stdout: true, stderr: true, tail: 200 });
      const lines = demultiplex(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).map((record) => record.line);
      return { exitCode: info.State.ExitCode, logs: tailLines(['$ npm test', ...lines]) };
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  async function verify({ session, resource, release, out, isCancelled }) {
    const deadline = Date.now() + limits.verifyMs;
    const log = [];
    let attempt = 0;
    let lastError = 'no probe attempted';
    while (Date.now() < deadline) {
      if (isCancelled()) {
        throw new Cancelled();
      }
      attempt += 1;
      const { observed } = await driver.currentObservation({ session, resource });
      if (observed.state === 'exited') {
        log.push(`Attempt ${attempt}: container ${resource.serviceId} exited with code ${observed.exitCode}; it cannot become healthy.`);
        return { status: 'failed', exitCode: 1, logs: log, reason: `GET /health cannot succeed: container ${resource.serviceId} exited with code ${observed.exitCode}.` };
      }
      const health = await driver.probeOnce({ session, resource, kind: 'health', out });
      if (health.ok) {
        log.push(`Attempt ${attempt}: GET http://${resource.serviceId}:${health.port}/health returned 200`);
        const version = await driver.probeOnce({ session, resource, kind: 'version', out });
        const observedVersion = version.ok ? version.body?.version : version.error;
        if (version.ok && observedVersion === release.version) {
          log.push(`GET /version returned ${observedVersion} as expected`);
          return { status: 'passed', exitCode: 0, logs: log };
        }
        log.push(`GET /version returned ${observedVersion}; expected ${release.version}`);
        return { status: 'failed', exitCode: 1, logs: log, reason: `version mismatch: expected ${release.version}, observed ${observedVersion}.` };
      }
      lastError = health.error;
      log.push(`Attempt ${attempt}: GET /health failed: ${health.error}`);
      await sleep(limits.verifyIntervalMs);
    }
    return { status: 'failed', exitCode: 1, logs: log, reason: `GET /health did not succeed within ${limits.verifyMs / 1000} s (${lastError}).` };
  }

  /** Execute one run, recording every stage through the shared pipeline recorder. */
  async function execute({ session, operation, out, isCancelled }) {
    const fixture = getFixture(session.fixtureId);
    let release;
    let kind;
    if (operation.type === 'pipeline.run') {
      if (!fixture.candidates.includes(operation.parameters.releaseId)) {
        throw new DriverFailure('RELEASE_NOT_APPROVED', `Release ${operation.parameters.releaseId} is not an approved candidate for this lab.`);
      }
      release = getReleaseById(operation.parameters.releaseId);
      kind = 'deploy';
    } else {
      const { knownGood, deployed } = session.pipeline;
      if (!knownGood) {
        throw new DriverFailure('NO_KNOWN_GOOD_RELEASE', 'No known-good release has been recorded yet.');
      }
      if (deployed?.releaseId === knownGood.releaseId && deployed.status === 'verified') {
        throw new DriverFailure('ALREADY_ON_KNOWN_GOOD', `Release ${knownGood.version} is already deployed and verified.`);
      }
      release = getReleaseById(knownGood.releaseId);
      kind = 'rollback';
    }

    let pipeline = session.pipeline;
    const ctx = {
      session: () => ({ pipeline }),
      now: () => new Date().toISOString(),
      emit(type, payload) {
        if (type === 'pipeline.updated') {
          pipeline = payload;
        }
        out.emit(type, payload);
      },
    };
    const recorder = createPipelineRecorder(ctx, { source: 'docker' });
    const runId = operation.id;
    const resource = session.resources.find((item) => item.serviceId === 'api');
    const stage = async (id, work) => {
      if (isCancelled()) {
        throw new Cancelled();
      }
      recorder.stageStart(runId, id);
      const outcome = await work();
      recorder.stageFinish(runId, id, outcome);
      if (outcome.status === 'failed') {
        throw new DriverFailure('PIPELINE_STAGE_FAILED', `${id}: ${outcome.reason}`);
      }
    };

    recorder.start(createRunRecord({ id: runId, kind, release, startedAt: ctx.now() }));
    try {
      await stage('validate', async () => ({
        status: 'passed', exitCode: 0,
        logs: [
          `Release ${release.id} (${release.image}) is approved for this lab.`,
          `Service configuration: appPort ${resource.desired.appPort}, expected probe port ${resource.desired.expectedProbePort}.`,
        ],
      }));
      if (kind === 'rollback') {
        recorder.skip(runId, 'test', 'Reusing the verified known-good image; tests are not re-run.');
        recorder.skip(runId, 'build', `Reusing the existing image ${release.image}.`);
      } else {
        await stage('test', async () => {
          const result = await runTests({ session, release, isCancelled });
          return result.exitCode === 0
            ? { status: 'passed', exitCode: 0, logs: result.logs }
            : { status: 'failed', exitCode: result.exitCode, logs: result.logs, reason: `npm test exited with code ${result.exitCode}.` };
        });
        await stage('build', async () => {
          const lines = [];
          await ensureReleaseImage(docker, release, { installationId, force: true, onLine: (line) => lines.push(line) });
          return { status: 'passed', exitCode: 0, logs: tailLines([`$ docker build -t ${release.image} labs/fixtures/api`, ...lines]) };
        });
      }
      await stage('deploy', async () => {
        const previous = pipeline.deployed;
        if (previous?.status === 'verified') {
          // Capture the observed known-good release before replacing it.
          recorder.setReleases(() => ({ knownGood: { releaseId: previous.releaseId, image: previous.image, version: previous.version } }));
        }
        const built = await ensureReleaseImage(docker, release, { installationId });
        const before = resource.desired.image;
        const { observed } = await driver.deploy({ session, resource, image: release.image, out });
        recorder.setReleases(() => ({ deployed: { ...releaseRef(release), status: 'unverified' } }));
        return {
          status: 'passed', exitCode: 0,
          logs: [
            ...(built.built ? [`Built missing image ${release.image}`] : []),
            `Replaced ${before} with ${release.image}`,
            `Container ${resource.serviceId} observed ${observed.state}${observed.exitCode !== null ? ` (exit ${observed.exitCode})` : ''}`,
          ],
        };
      });
      const deployedResource = { ...resource, desired: { ...resource.desired, image: release.image } };
      try {
        await stage('verify', () => verify({ session, resource: deployedResource, release, out, isCancelled }));
      } catch (error) {
        recorder.setReleases(() => ({ deployed: { ...releaseRef(release), status: 'failed' } }));
        throw error;
      }
      recorder.setReleases(() => ({ deployed: { ...releaseRef(release), status: 'verified' }, knownGood: releaseRef(release) }));
      recorder.finish(runId, { status: 'passed' });
      return { runId, kind, release: releaseRef(release), status: 'passed' };
    } catch (error) {
      if (error instanceof Cancelled) {
        // The controller already reconciled the cancelled run; stop quietly.
        throw new DriverFailure('CANCELLED', 'The pipeline run was cancelled.');
      }
      const reason = error instanceof DriverFailure ? error.message : 'The pipeline failed unexpectedly.';
      recorder.finish(runId, { status: 'failed', failureReason: reason });
      throw error instanceof DriverFailure ? error : new DriverFailure('PIPELINE_FAILED', reason, { retryable: true });
    }
  }

  return { execute, runTests };
}
