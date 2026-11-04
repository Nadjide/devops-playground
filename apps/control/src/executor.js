/**
 * Local execution backend. Workload operations are not available until the
 * runner implements them, so no local lab is offered yet and capabilities
 * stay honest instead of falling back to simulation.
 */
export function createLocalExecutorFactory({ runner }) {
  const operations = [];
  return {
    operations,
    factory() {
      if (!runner) {
        throw new Error('Local execution requires a runner.');
      }
      return {
        backend: 'Local Docker',
        supportedOperations: operations,
        async setup() {
          throw new Error('Local fixtures are not available yet.');
        },
        async execute() {
          throw new Error('Local operations are not available yet.');
        },
      };
    },
  };
}
