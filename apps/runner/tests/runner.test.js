import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createRunnerApp } from '../src/app.js';
import { loadRunnerConfig } from '../src/config.js';
import { classifyDockerError, diagnoseDocker } from '../src/docker/diagnostics.js';

const TOKEN = 'test-runner-token-0123456789abcdefghijklmnop';

function dockerStub({ version = { Version: '29.7.2', ApiVersion: '1.52', Os: 'linux', Arch: 'amd64' }, info = { OSType: 'linux', OperatingSystem: 'Docker Desktop' }, fail } = {}) {
  return {
    version: async () => {
      if (fail) {
        throw fail;
      }
      return version;
    },
    info: async () => info,
  };
}

const app = (docker = dockerStub()) => createRunnerApp({ config: { token: TOKEN }, docker });

describe('runner authentication', () => {
  it.each([
    [{}, 401, 'UNAUTHENTICATED'],
    [{ Authorization: 'Bearer wrong-token' }, 401, 'UNAUTHENTICATED'],
    [{ Authorization: `Basic ${TOKEN}` }, 401, 'UNAUTHENTICATED'],
    [{ Authorization: `Bearer ${TOKEN}`, Origin: 'http://127.0.0.1:3001' }, 403, 'BROWSER_ORIGIN_REJECTED'],
    [{ Authorization: `Bearer ${TOKEN}`, 'Sec-Fetch-Site': 'same-origin' }, 403, 'BROWSER_ORIGIN_REJECTED'],
  ])('rejects %j', async (headers, status, code) => {
    let req = request(app()).get('/v1/health');
    for (const [name, value] of Object.entries(headers)) {
      req = req.set(name, value);
    }
    const response = await req;
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });

  it('answers authenticated health and unknown routes with typed errors', async () => {
    const health = await request(app()).get('/v1/health').set('Authorization', `Bearer ${TOKEN}`);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', service: 'devops-playground-runner' });
    const missing = await request(app()).get('/v1/exec').set('Authorization', `Bearer ${TOKEN}`);
    expect(missing.status).toBe(404);
  });

  it('requires a long per-launch token', () => {
    expect(() => loadRunnerConfig({ RUNNER_TOKEN: 'short' })).toThrow(/at least 32 characters/);
    expect(loadRunnerConfig({ RUNNER_TOKEN: TOKEN })).toMatchObject({ port: 4000, socketPath: '/var/run/docker.sock' });
  });
});

describe('Docker diagnostics', () => {
  it('reports the daemon version when available', async () => {
    const response = await request(app()).get('/v1/docker').set('Authorization', `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      available: true, serverVersion: '29.7.2', apiVersion: '1.52', os: 'linux', arch: 'amd64', operatingSystem: 'Docker Desktop',
    });
  });

  it.each([
    [{ code: 'ENOENT' }, 'DOCKER_UNAVAILABLE'],
    [{ code: 'ECONNREFUSED' }, 'DOCKER_UNAVAILABLE'],
    [{ code: 'EACCES' }, 'DOCKER_PERMISSION_DENIED'],
    [{ statusCode: 500 }, 'DOCKER_ERROR'],
  ])('classifies %j as %s without leaking details', async (fail, code) => {
    const response = await request(app(dockerStub({ fail: Object.assign(new Error('/var/run/docker.sock secret'), fail) })))
      .get('/v1/docker').set('Authorization', `Bearer ${TOKEN}`);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ available: false, error: { code, retryable: true } });
    expect(response.body.error.message).not.toContain('secret');
  });

  it('rejects Windows container contexts and times out a silent daemon', async () => {
    expect(await diagnoseDocker(dockerStub({ info: { OSType: 'windows' } })))
      .toMatchObject({ available: false, error: { code: 'DOCKER_CONTEXT_UNSUPPORTED' } });
    const silent = { version: () => new Promise(() => {}), info: async () => ({}) };
    expect(await diagnoseDocker(silent, { timeoutMs: 20 })).toMatchObject({ available: false, error: { code: 'DOCKER_UNAVAILABLE' } });
    expect(classifyDockerError({ code: 'DOCKER_TIMEOUT' }).code).toBe('DOCKER_UNAVAILABLE');
  });
});
