import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createSimulatorExecutor } from '@devops-playground/lab-core';
import { createCommandHistory, createTerminalState, HISTORY_LIMIT } from '../src/terminal/state.js';
import { runTerminalCommand } from '../src/terminal/commands.js';
import { createTestClient, renderApp } from './helpers.jsx';
import { xtermInstances } from './xterm-fake.js';
import { setDesktopViewport } from './setup.js';

const xterm = { instances: xtermInstances, observers: [] };

class TrackingObserver {
  constructor() {
    this.disconnected = false;
    xterm.observers.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}

beforeEach(() => {
  xterm.observers.length = 0;
  globalThis.ResizeObserver = TrackingObserver;
});

async function run(client, input, requestLifecycle = vi.fn()) {
  const pending = runTerminalCommand(input, { client, requestLifecycle });
  await client.clock.runAll();
  return pending;
}

describe('terminal state', () => {
  it('bounds command history and navigates it like a shell', () => {
    const history = createCommandHistory();
    for (let index = 0; index < HISTORY_LIMIT + 20; index += 1) {
      history.push(`docker logs api --tail ${index + 1}`);
    }
    history.push('   ');
    history.push('docker ps');
    history.push('docker ps');
    expect(history.entries()).toHaveLength(HISTORY_LIMIT);
    expect(history.previous()).toBe('docker ps');
    expect(history.previous()).toBe('docker logs api --tail 120');
    expect(history.next()).toBe('docker ps');
    expect(history.next()).toBe('');
  });

  it('clears only the terminal presentation', () => {
    const state = createTerminalState();
    state.append('hello');
    state.clear();
    expect(state.transcript()).toEqual([]);
  });
});

describe('terminal commands', () => {
  it('reaches the same domain outcome as the start button', async () => {
    const viaTerminal = createTestClient();
    const viaButton = createTestClient();
    await Promise.all([viaTerminal.ready, viaButton.ready]);

    const output = await run(viaTerminal, 'docker start api');
    await viaButton.dispatch({ type: 'container.start', generation: 1, parameters: { serviceId: 'api' } });
    await viaButton.clock.runAll();

    expect(output.lines).toEqual([{ text: 'api', tone: 'success' }]);
    const strip = (session) => session.resources.map(({ observed }) => ({ ...observed, observedAt: null, startedAt: null }));
    expect(strip(viaTerminal.getSnapshot().session)).toEqual(strip(viaButton.getSnapshot().session));
    expect(viaTerminal.getSnapshot().session.operations.map((operation) => operation.type)).toEqual(['container.start']);
  });

  it('rejects injection-shaped input without touching session state', async () => {
    const client = createTestClient();
    await client.ready;
    const before = client.getSnapshot().session;
    for (const input of ['docker start api; rm -rf /', 'curl http://169.254.169.254/latest', '$(reboot)', 'docker ps\ndocker stop api']) {
      const output = await run(client, input);
      expect(output.lines[0].tone).toBe('error');
    }
    expect(client.getSnapshot().session).toBe(before);
  });

  it('prints health bodies, connection failures, logs, and status', async () => {
    const client = createTestClient();
    await client.ready;
    expect((await run(client, 'curl http://api:3000/health')).lines[0].text)
      .toBe('curl: (7) Failed to connect to api port 3000: Connection refused');
    expect((await run(client, 'docker logs api --tail 1')).lines.map((line) => line.text))
      .toEqual(['HTTP server closed, exiting with code 0']);
    await run(client, 'docker start api');
    expect(JSON.parse((await run(client, 'curl http://api:3000/version')).lines[0].text))
      .toEqual({ name: 'devops-playground', version: '1.0.0', environment: 'production' });
    const status = (await run(client, 'lab status')).lines.map((line) => line.text).join('\n');
    expect(status).toMatch(/Mode\s+Demo \(simulated\)/);
    expect(status).toMatch(/Service\s+api: running/);
    expect((await run(client, 'pipeline run')).lines[0].text).toMatch(/Error: The active lab does not allow this operation/);
  });

  it('routes lab reset through the shared confirmation path', async () => {
    const client = createTestClient();
    await client.ready;
    const declined = await run(client, 'lab reset', (type, { onSettled }) => onSettled(null));
    expect(declined.lines[0].text).toBe('Reset cancelled.');
    const requestLifecycle = vi.fn(async (type, { onSettled }) => {
      onSettled(await client.dispatch({ type, generation: 1, parameters: {} }));
    });
    const accepted = await run(client, 'lab reset', requestLifecycle);
    expect(requestLifecycle).toHaveBeenCalledWith('session.reset', expect.any(Object));
    expect(accepted.lines[0].text).toBe('Session reset to generation 2.');
  });
});

describe('terminal panel', () => {
  it('dispatches typed commands and disposes xterm resources on unmount', async () => {
    const { advance, unmount, client } = await renderApp();
    const terminal = await vi.waitFor(() => {
      expect(xterm.instances).toHaveLength(1);
      return xterm.instances[0];
    });
    expect(terminal.options).toMatchObject({ scrollback: 1000, screenReaderMode: true });
    act(() => {
      terminal.handler('docker start api');
      terminal.handler('\r');
    });
    await advance(1000);
    expect(client.getSnapshot().session.resources[0].observed.state).toBe('running');
    expect(terminal.output).toContain('api');

    unmount();
    expect(terminal.disposed).toBe(true);
    expect(terminal.dataDisposed).toBe(true);
    expect(xterm.observers.every((observer) => observer.disconnected)).toBe(true);
  });

  it('buffers keystrokes typed while a command runs and replays them', async () => {
    const { advance, client } = await renderApp();
    const terminal = await vi.waitFor(() => xterm.instances[0] ?? Promise.reject(new Error('not mounted')));
    act(() => {
      terminal.handler('docker start api');
      terminal.handler('\r');
      terminal.handler('docker ps');
      terminal.handler('\r');
    });
    await advance(1000);
    await advance(10);
    expect(client.getSnapshot().session.resources[0].observed.state).toBe('running');
    expect(terminal.output).toMatch(/SERVICE[\s\S]*running/);
  });

  it('rejects multiline paste and strips control characters from input', async () => {
    await renderApp();
    const terminal = await vi.waitFor(() => xterm.instances[0] ?? Promise.reject(new Error('not mounted')));
    act(() => terminal.handler('docker ps\ndocker stop api\n'));
    expect(terminal.output).toContain('Multiline input is not supported');
    act(() => terminal.handler('do\u0007cker'));
    expect(terminal.output.endsWith('docker')).toBe(true);
  });
});

describe('logs panel', () => {
  function hostileClient(lineCount = 3) {
    const simulator = createSimulatorExecutor();
    return createTestClient({
      executor: {
        ...simulator,
        async setup(input) {
          const setup = await simulator.setup(input);
          const hostile = '<img src=x onerror="window.pwned=1">\u001b]0;title\u0007\u001b[31mred';
          const extra = Array.from({ length: lineCount }, (_, index) => ({
            serviceId: 'api', stream: index === 0 ? 'stderr' : 'stdout', level: 'info', at: input.now,
            message: index === 0 ? hostile : `filler ${index}`,
          }));
          return { ...setup, logs: [...setup.logs, ...extra] };
        },
      },
    });
  }

  it('reads logs on open as evidence and renders hostile text inertly', async () => {
    setDesktopViewport(true);
    const client = hostileClient();
    const { advance } = await renderApp({ client });
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Logs' }));
    await advance(100);
    const logs = screen.getByRole('list', { name: 'Workload log entries' });
    expect(logs).toHaveTextContent('<img src=x onerror="window.pwned=1">red');
    expect(logs.querySelector('img')).toBeNull();
    expect(window.pwned).toBeUndefined();
    const reads = client.getSnapshot().session.operations.filter((operation) => operation.type === 'container.logs');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ status: 'succeeded', parameters: { serviceId: 'api', tail: 200 } });
  });

  it('shows truncation and clears only the visible view', async () => {
    const client = hostileClient(600);
    const actor = userEvent.setup();
    await renderApp({ client });
    await actor.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(screen.getByRole('note')).toHaveTextContent(/older entries were discarded by the retention limit/);
    await actor.click(screen.getByRole('button', { name: 'Clear view' }));
    expect(screen.queryByRole('list', { name: 'Workload log entries' })).not.toBeInTheDocument();
    expect(client.getSnapshot().session.logs.entries).toHaveLength(500);
    await actor.click(screen.getByRole('button', { name: 'Show all entries' }));
    expect(within(screen.getByRole('list', { name: 'Workload log entries' })).getAllByRole('listitem')).toHaveLength(500);
  });
});
