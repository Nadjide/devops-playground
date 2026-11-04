import { createControlApp } from './app.js';
import { loadControlConfig } from './config.js';
import { createRunnerClient } from './runner-client.js';
import { createSessionStore } from './sessions/store.js';
import { createLocalExecutorFactory } from './executor.js';

const config = loadControlConfig();
const runner = config.mode === 'local' ? createRunnerClient({ url: config.runnerUrl, token: config.runnerToken }) : null;
const { factory, operations } = createLocalExecutorFactory({ runner });
const store = createSessionStore({ executorFactory: factory, onError: (error) => console.error(error) });
const app = createControlApp({ config, store, runner, operations, executorFactory: runner ? factory : null });

const server = app.listen(config.port, config.host, () => {
  console.log(`DevOps Playground control (${config.mode} mode) listening on ${config.host}:${config.port}`);
});

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    server.close();
    await store.shutdown();
    store.dispose();
    process.exit(0);
  });
}
