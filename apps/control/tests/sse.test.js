import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowser, createTestApp, ORIGIN } from './helpers.js';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(server.address().port);
    });
  });
}

/** Read SSE frames until `done(frames)` is true, then disconnect. Uses node:http to set Host. */
function readEvents(port, path, { cookie, lastEventId, done }) {
  return new Promise((resolve, reject) => {
    const frames = [];
    let buffer = '';
    const req = http.get({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Host: '127.0.0.1:3001',
        Origin: ORIGIN,
        Cookie: cookie,
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
    }, (res) => {
      if (!String(res.headers['content-type']).includes('text/event-stream')) {
        reject(new Error(`Unexpected response ${res.statusCode} ${res.headers['content-type']}`));
        req.destroy();
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (!raw.startsWith(':')) {
            const fields = Object.fromEntries(raw.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
            frames.push({ id: fields.id ?? null, event: fields.event, data: JSON.parse(fields.data) });
          }
        }
        if (done(frames)) {
          clearTimeout(timer);
          req.destroy();
          resolve(frames);
        }
      });
    });
    req.on('error', (error) => {
      if (error.code !== 'ECONNRESET') {
        reject(error);
      }
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve(frames);
    }, 3000);
  });
}

describe('session event stream', () => {
  it('streams live events and replays only events after Last-Event-ID', async () => {
    const { app, clock } = createTestApp();
    const browser = await createBrowser(app);
    const cookie = browser.cookie[0].split(';')[0];
    const session = (await browser.post('/api/sessions', { labId: 'stopped-container' })).body.session;
    const port = await listen(app);
    const path = `/api/sessions/${session.id}/events`;

    const live = readEvents(port, path, { cookie, done: (frames) => frames.some((frame) => frame.data.type === 'operation.succeeded') });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await browser.post(`${path.replace('/events', '/operations')}`, { type: 'container.start', generation: 1, parameters: { serviceId: 'api' } }, { key: 'sse-start' });
    await clock.runAll();
    const frames = await live;
    expect(frames[0]).toMatchObject({ event: 'ready', data: { sessionId: session.id } });
    const domain = frames.filter((frame) => frame.event === 'domain');
    expect(domain.map((frame) => frame.data.type)).toContain('resource.observed');
    expect(domain.every((frame) => frame.id === frame.data.id)).toBe(true);
    const sequences = domain.map((frame) => frame.data.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);

    const cursor = domain[1].id;
    const replay = await readEvents(port, path, { cookie, lastEventId: cursor, done: (items) => items.length >= domain.length - 2 });
    expect(replay[0].data.sequence).toBe(domain[1].data.sequence + 1);
    expect(replay.every((frame) => frame.event === 'domain')).toBe(true);
  });

  it('requires a fresh snapshot for foreign epochs and unknown cursors', async () => {
    const { app } = createTestApp();
    const browser = await createBrowser(app);
    const cookie = browser.cookie[0].split(';')[0];
    const session = (await browser.post('/api/sessions', { labId: 'stopped-container' })).body.session;
    const port = await listen(app);
    const path = `/api/sessions/${session.id}/events`;
    for (const lastEventId of [`${session.id}:old-epoch:3`, `${session.id}:${session.eventEpoch}:9999`, 'garbage']) {
      const frames = await readEvents(port, path, { cookie, lastEventId, done: (items) => items.length >= 1 });
      expect(frames[0]).toMatchObject({ event: 'snapshot.required', data: { reason: 'cursor-unavailable' } });
    }
  });
});
