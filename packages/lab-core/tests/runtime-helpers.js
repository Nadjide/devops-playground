import {
  createLabRuntime, createSimulatorExecutor, createVirtualClock, sessionSchema,
} from '../src/index.js';

export async function startRuntime({ labId = 'stopped-container', executor = createSimulatorExecutor(), ...options } = {}) {
  const clock = createVirtualClock();
  let counter = 0;
  const errors = [];
  const runtime = createLabRuntime({
    labId,
    executor,
    clock,
    nextId: () => `id-${String(++counter).padStart(4, '0')}`,
    onError: (error) => errors.push(error),
    ...options,
  });
  await runtime.start();
  let keyCounter = 0;
  const submit = (type, parameters = {}, { key = `key-${++keyCounter}`, generation } = {}) =>
    runtime.submit({ type, generation: generation ?? runtime.getSession().generation, parameters }, { idempotencyKey: key });
  const run = async (type, parameters, options) => {
    const operation = submit(type, parameters, options);
    const settled = runtime.settled(operation.id);
    await clock.runAll();
    return settled;
  };
  const api = () => runtime.getSession().resources.find((resource) => resource.serviceId === 'api');
  const valid = () => sessionSchema.parse(runtime.getSession());
  return { runtime, clock, submit, run, api, errors, valid };
}
