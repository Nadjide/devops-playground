const DIAGNOSTIC_TIMEOUT_MS = 5000;

export function withTimeout(promise, ms, code = 'DOCKER_TIMEOUT') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Docker did not answer in time.'), { code })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Map daemon access failures to typed, actionable, secret-free diagnostics. */
export function classifyDockerError(error) {
  const code = error?.code ?? error?.errno;
  if (code === 'EACCES' || code === 'EPERM' || error?.statusCode === 403) {
    return {
      code: 'DOCKER_PERMISSION_DENIED',
      message: 'The runner cannot access the Docker socket. Check the socket group passed by the launcher.',
      retryable: true,
    };
  }
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'DOCKER_TIMEOUT') {
    return {
      code: 'DOCKER_UNAVAILABLE',
      message: 'The Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry.',
      retryable: true,
    };
  }
  return { code: 'DOCKER_ERROR', message: 'Docker returned an unexpected error.', retryable: true };
}

export async function diagnoseDocker(docker, { timeoutMs = DIAGNOSTIC_TIMEOUT_MS } = {}) {
  try {
    const version = await withTimeout(docker.version(), timeoutMs);
    const info = await withTimeout(docker.info(), timeoutMs);
    if (info.OSType && info.OSType !== 'linux') {
      return {
        available: false,
        error: { code: 'DOCKER_CONTEXT_UNSUPPORTED', message: 'Switch Docker to Linux containers to run the local lab.', retryable: true },
      };
    }
    return {
      available: true,
      serverVersion: version.Version ?? null,
      apiVersion: version.ApiVersion ?? null,
      os: version.Os ?? null,
      arch: version.Arch ?? null,
      operatingSystem: info.OperatingSystem ?? null,
    };
  } catch (error) {
    return { available: false, error: classifyDockerError(error) };
  }
}
