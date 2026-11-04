import { describe, expect, it } from 'vitest';
import {
  createSimulatorExecutor, eventSchema, LIMITS, MAX_COMMAND_LENGTH, parseCommand,
  sanitizeLogMessage, sanitizeTerminalText,
} from '../src/index.js';
import { startRuntime } from './runtime-helpers.js';

const context = { services: ['api'], probePorts: { api: 3000 } };
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('supported command grammar', () => {
  it.each([
    ['help', { kind: 'local', action: 'help' }],
    ['clear', { kind: 'local', action: 'clear' }],
    ['lab status', { kind: 'local', action: 'lab.status' }],
    ['lab reset', { kind: 'confirm', type: 'session.reset' }],
    ['docker ps', { kind: 'local', action: 'docker.ps' }],
    ['docker inspect api', { kind: 'operation', request: { type: 'container.inspect', parameters: { serviceId: 'api' } } }],
    ['docker logs api', { kind: 'operation', request: { type: 'container.logs', parameters: { serviceId: 'api', tail: 50 } } }],
    ['docker logs api --tail 50', { kind: 'operation', request: { type: 'container.logs', parameters: { serviceId: 'api', tail: 50 } } }],
    ['docker logs --tail=1 api', { kind: 'operation', request: { type: 'container.logs', parameters: { serviceId: 'api', tail: 1 } } }],
    ['docker logs api -n 200', { kind: 'operation', request: { type: 'container.logs', parameters: { serviceId: 'api', tail: 200 } } }],
    ['docker start api', { kind: 'operation', request: { type: 'container.start', parameters: { serviceId: 'api' } } }],
    ['docker stop api', { kind: 'operation', request: { type: 'container.stop', parameters: { serviceId: 'api' } } }],
    ['docker restart api', { kind: 'operation', request: { type: 'container.restart', parameters: { serviceId: 'api' } } }],
    ['curl http://api:3000/health', { kind: 'operation', request: { type: 'health.probe', parameters: { serviceId: 'api' } } }],
    ['curl http://api:3000/version', { kind: 'operation', request: { type: 'version.probe', parameters: { serviceId: 'api' } } }],
    ['pipeline rollback', { kind: 'operation', request: { type: 'pipeline.rollback', parameters: {} } }],
    ['  docker   "start"  \'api\'  ', { kind: 'operation', request: { type: 'container.start', parameters: { serviceId: 'api' } } }],
    ['', { kind: 'empty' }],
  ])('parses %j', (input, expected) => {
    expect(parseCommand(input, context)).toMatchObject(expected);
  });

  it('maps pipeline run to the lab candidate release', () => {
    expect(parseCommand('pipeline run', { ...context, candidateReleaseId: 'api-1-1-0' }))
      .toMatchObject({ request: { type: 'pipeline.run', parameters: { releaseId: 'api-1-1-0' } } });
    expect(parseCommand('pipeline run', context)).toMatchObject({ kind: 'error', message: 'This lab has no pipeline candidate.' });
  });
});

describe('rejected command input', () => {
  it.each([
    ['docker ps | grep api', /Shell operators/],
    ['docker logs api > /tmp/out', /Shell operators/],
    ['docker logs api 2>&1', /Shell operators/],
    ['curl $(cat /etc/passwd)', /Shell operators/],
    ['docker start `whoami`', /Shell operators/],
    ['docker start api; rm -rf /', /Shell operators/],
    ['docker start api && docker stop api', /Shell operators/],
    ['docker inspect *', /Shell operators/],
    ['docker ps\nrm -rf /', /Multiline/],
    [`docker ps ${ESC}[2J`, /Control characters/],
    ['FOO=bar docker ps', /Environment assignments/],
    ['docker ps -a', /Unsupported option '-a'/],
    ['docker logs api --follow', /Unknown flag '--follow'/],
    ['docker stop -t 0 api', /Unknown flag '-t'/],
    ['docker logs api --tail 0', /--tail accepts/],
    ['docker logs api --tail 201', /--tail accepts/],
    ['docker logs api --tail ten', /--tail accepts/],
    ['docker logs api --tail', /--tail accepts/],
    ['docker start db', /Unknown service 'db'/],
    ['docker start api api', /Usage: docker start/],
    ['docker exec api sh', /Unsupported docker command 'exec'/],
    ['docker run --privileged alpine', /Unsupported docker command 'run'/],
    ['curl http://example.com/health', /Unsupported URL/],
    ['curl https://api:3000/health', /Unsupported URL/],
    ['curl http://api:3000/admin', /Unsupported URL/],
    ['curl http://api:3001/health', /not an approved probe port/],
    ['curl http://db:3000/health', /Unknown service 'db'/],
    ['curl -X POST http://api:3000/health', /curl options/],
    ['curl http://169.254.169.254:80/health', /Unsupported URL/],
    ['bash', /Unknown command 'bash'/],
    ['sh -c "docker ps"', /Unknown command 'sh'/],
    ['lab destroy', /Usage: lab status/],
    ['docker "unterminated', /could not be parsed|Unsupported docker command/],
    ['x'.repeat(MAX_COMMAND_LENGTH + 1), /limited to 512/],
  ])('rejects %j with guidance', (input, message) => {
    const result = parseCommand(input, context);
    expect(result.kind).toBe('error');
    expect(result.message).toMatch(message);
    expect(result.hint).toEqual(expect.any(String));
  });
});

describe('terminal and log sanitization', () => {
  it('removes escape sequences that could control the terminal', () => {
    expect(sanitizeTerminalText(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeTerminalText(`${ESC}]0;owned${BEL}title`)).toBe('title');
    expect(sanitizeTerminalText(`${ESC}]8;;http://evil${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link');
    expect(sanitizeTerminalText(`clear${ESC}[2J${ESC}[H`)).toBe('clear');
    expect(sanitizeTerminalText(`a${String.fromCharCode(0x9b)}2Jb`)).toBe('ab');
    expect(sanitizeTerminalText('bell\u0007 and\rcarriage')).toBe('bell� and�carriage');
    expect(sanitizeTerminalText('tab\tkept')).toBe('tab\tkept');
  });

  it('keeps HTML-like text as inert text and bounds long lines', () => {
    expect(sanitizeLogMessage('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
    const long = sanitizeLogMessage('é'.repeat(10_000));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(LIMITS.logLineBytes);
    expect(long.endsWith(' … [truncated]')).toBe(true);
    expect(sanitizeLogMessage('   ')).toBe('(empty line)');
  });

  it('sanitizes hostile workload output at ingestion', async () => {
    const simulator = createSimulatorExecutor();
    const executor = {
      ...simulator,
      async setup(input) {
        const setup = await simulator.setup(input);
        return {
          ...setup,
          logs: [{ serviceId: 'api', stream: 'stdout', level: 'info', at: input.now, message: `${ESC}]0;pwned${BEL}${ESC}[2Jhello\n<script>` }],
        };
      },
    };
    const { valid } = await startRuntime({ executor });
    expect(valid().logs.entries[0].message).toBe('hello�<script>');
  });

  it('rejects unsanitized control characters in log events', () => {
    const event = {
      schemaVersion: 1, id: 's:e:1', sessionId: 's', generation: 1, eventEpoch: 'e', sequence: 1, revision: 1,
      type: 'log.appended', occurredAt: '2026-11-04T10:00:00.000Z', operationId: null, source: 'simulator',
      payload: { entries: [{ serviceId: 'api', stream: 'stdout', level: 'info', message: `${ESC}[2J`, at: '2026-11-04T10:00:00.000Z' }] },
    };
    expect(eventSchema.safeParse(event).success).toBe(false);
  });
});
