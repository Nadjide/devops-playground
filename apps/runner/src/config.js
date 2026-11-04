export const MIN_TOKEN_LENGTH = 32;

/** Read trusted startup configuration. The token is generated per launch by the launcher. */
export function loadRunnerConfig(env = process.env) {
  const token = env.RUNNER_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`RUNNER_TOKEN must be a per-launch secret of at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  return {
    token,
    host: env.RUNNER_HOST ?? '0.0.0.0',
    port: Number(env.RUNNER_PORT ?? 4000),
    socketPath: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    installationFile: env.PLAYGROUND_INSTALLATION_FILE ?? null,
  };
}
