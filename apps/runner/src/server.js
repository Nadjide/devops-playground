import Docker from 'dockerode';
import { createRunnerApp } from './app.js';
import { loadRunnerConfig } from './config.js';
import { loadInstallationId } from './installation.js';
import { createLabDriver } from './docker/lab-driver.js';

const config = loadRunnerConfig();
const docker = new Docker({ socketPath: config.socketPath });
const installationId = loadInstallationId(config.installationFile);
const driver = createLabDriver({ docker, installationId });
const app = createRunnerApp({ config, docker, driver });

const server = app.listen(config.port, config.host, () => {
  // Never log the token or the environment.
  console.log(`DevOps Playground runner listening on ${config.host}:${config.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
