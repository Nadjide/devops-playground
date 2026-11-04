import http from 'node:http';
import { spawnSync } from 'node:child_process';

export const PORT = Number(process.env.PLAYGROUND_PORT ?? 3001);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

export function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Container logs with stdout and stderr combined, as `docker logs` prints them. */
export function containerLogs(id) {
  const result = spawnSync('docker', ['logs', id], { encoding: 'utf8', shell: false });
  return `${result.stdout}${result.stderr}`;
}

/** End a session if it is still open, so one failing test cannot block the next one. */
export async function endIfOpen(browser, sessionId) {
  const current = await browser.session(sessionId);
  if (current && current.status !== 'ended') {
    await browser.run(sessionId, 'session.end');
  }
}

/** Run `work` with a fresh session and always end it, so one failure cannot block the next test. */
export async function withSession(browser, labId, work) {
  const session = await browser.createSession(labId);
  try {
    return await work(session);
  } finally {
    const current = await browser.session(session.id);
    if (current && current.status !== 'ended') {
      await browser.run(session.id, 'session.end');
    }
  }
}

export function launcher(command) {
  const result = spawnSync(process.execPath, ['scripts/playground.js', command], { encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`playground ${command} failed`);
  }
}

/** A browser-like API client: cookie jar, CSRF token, same-origin headers. */
export function createBrowser() {
  let cookie = '';
  let csrf = '';
  function request(method, path, { body, key } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          Host: `127.0.0.1:${PORT}`,
          Origin: ORIGIN,
          Accept: 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
      }, (res) => {
        const setCookie = res.headers['set-cookie']?.[0];
        if (setCookie) {
          cookie = setCookie.split(';')[0];
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      req.setTimeout(10 * 60_000, () => req.destroy(new Error('request timeout')));
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
  let counter = 0;
  const browser = {
    request,
    async connect() {
      csrf = (await request('GET', '/api/security/csrf')).body.token;
      return browser;
    },
    async createSession(labId) {
      const response = await request('POST', '/api/sessions', { body: { labId } });
      if (response.status !== 201) {
        throw new Error(`session creation failed: ${JSON.stringify(response.body)}`);
      }
      return response.body.session;
    },
    session: async (id) => (await request('GET', `/api/sessions/${id}`)).body.session,
    async run(sessionId, type, parameters = {}) {
      const session = await browser.session(sessionId);
      counter += 1;
      const accepted = await request('POST', `/api/sessions/${sessionId}/operations`, {
        body: { type, generation: session.generation, parameters },
        key: `it-${Date.now()}-${counter}`,
      });
      if (accepted.status !== 202) {
        return { rejected: accepted };
      }
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const { body } = await request('GET', `/api/sessions/${sessionId}/operations/${accepted.body.operation.id}`);
        if (TERMINAL.includes(body.operation.status)) {
          return body.operation;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`${type} did not finish`);
    },
  };
  return browser;
}

/** Containers labeled with the session; pass `role` to exclude, e.g., disposable pipeline test containers. */
export function ownedContainers(sessionId, { role } = {}) {
  return docker('ps', '-a', '--filter', `label=devops-playground.session=${sessionId}`, '--filter', 'label=devops-playground.managed=true',
    ...(role ? ['--filter', `label=devops-playground.role=${role}`] : []),
    '--format', '{{.ID}} {{.Label "devops-playground.installation"}} {{.Names}} {{.State}}').split('\n').filter(Boolean)
    .map((line) => {
      const [id, installation, name, state] = line.split(' ');
      return { id, installation, name, state };
    });
}
