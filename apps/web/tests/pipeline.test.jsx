import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SIMULATED_TIMINGS } from '@devops-playground/lab-core';
import { runTerminalCommand } from '../src/terminal/commands.js';
import { createTestClient, renderApp } from './helpers.jsx';

async function openPipeline(actor) {
  await actor.click(screen.getByRole('tab', { name: 'Pipeline' }));
}

describe('pipeline panel', () => {
  it('shows the failed candidate, its stages, and the known-good release', async () => {
    const actor = userEvent.setup();
    await renderApp({ client: createTestClient({ labId: 'broken-release' }) });
    await openPipeline(actor);
    expect(screen.getByText('Simulated pipeline')).toBeInTheDocument();
    const stages = screen.getByRole('list', { name: 'Pipeline stages' });
    expect(within(stages).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(['validate passed', 'test passed', 'build passed', 'deploy passed', 'verify failed']);
    expect(screen.getByRole('note')).toHaveTextContent('GET /health did not succeed within 4 attempts');
    expect(screen.getByLabelText('verify stage logs')).toHaveTextContent('ECONNREFUSED');
    await actor.click(within(stages).getByRole('button', { name: 'test passed' }));
    expect(screen.getByLabelText('test stage logs')).toHaveTextContent('Tests: 3 passed, 3 total');
    expect(screen.getByText(/1\.0\.0 \(devops-playground-lab\/api:1\.0\.0\)/)).toBeInTheDocument();
  });

  it('rolls back through the button and completes M03 after reading logs', async () => {
    const actor = userEvent.setup();
    const client = createTestClient({ labId: 'broken-release' });
    const { settle } = await renderApp({ client });
    await openPipeline(actor);
    await actor.click(screen.getByRole('button', { name: 'Roll back' }));
    await settle();
    const session = client.getSnapshot().session;
    expect(session.pipeline.deployed).toMatchObject({ version: '1.0.0', status: 'verified' });
    expect(within(screen.getByRole('list', { name: 'Pipeline stages' })).getByRole('button', { name: 'verify passed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Roll back' })).toHaveAttribute('aria-disabled', 'true');
    await actor.click(screen.getByRole('tab', { name: 'Docker' }));
    await actor.click(screen.getByRole('button', { name: 'Read logs of api' }));
    await settle();
    expect(client.getSnapshot().session.mission.status).toBe('completed');
  });

  it('cancels a run before deploy and refuses it afterwards', async () => {
    const actor = userEvent.setup();
    const client = createTestClient({ labId: 'free-exploration' });
    const { advance, settle } = await renderApp({ client });
    await openPipeline(actor);
    const cancel = screen.getByRole('button', { name: 'Cancel run' });
    expect(cancel).toHaveAttribute('data-tooltip', 'No run in progress');
    await actor.click(screen.getByRole('button', { name: 'Run pipeline (1.0.1)' }));
    await advance(SIMULATED_TIMINGS.validate + 50);
    expect(screen.getByRole('button', { name: 'Cancel run' })).not.toHaveAttribute('aria-disabled');
    await actor.click(screen.getByRole('button', { name: 'Cancel run' }));
    await settle();
    expect(client.getSnapshot().session.pipeline.runs.at(-1).status).toBe('cancelled');

    await actor.click(screen.getByRole('button', { name: 'Run pipeline (1.0.1)' }));
    await advance(SIMULATED_TIMINGS.validate + SIMULATED_TIMINGS.test + SIMULATED_TIMINGS.build + 100);
    expect(screen.getByRole('button', { name: 'Cancel run' })).toHaveAttribute('data-tooltip', 'Not safe once deploy has started');
    await settle();
    expect(client.getSnapshot().session.pipeline.deployed).toMatchObject({ version: '1.0.1', status: 'verified' });
  });
});

describe('pipeline terminal commands', () => {
  it('reports stage results for pipeline run and rollback', async () => {
    const client = createTestClient({ labId: 'broken-release' });
    await client.ready;
    const run = async (input) => {
      const pending = runTerminalCommand(input, { client, requestLifecycle: () => {} });
      await client.clock.runAll();
      return (await pending).lines.map((line) => line.text).join('\n');
    };
    const failed = await run('pipeline run');
    expect(failed).toMatch(/Pipeline for release 1\.1\.0: failed/);
    expect(failed).toMatch(/verify\s+failed/);
    const rollback = await run('pipeline rollback');
    expect(rollback).toMatch(/Rollback for release 1\.0\.0: passed/);
    expect(rollback).toMatch(/test\s+skipped/);
    expect(rollback).toMatch(/Deployed: 1\.0\.0 \(verified\)/);
  });
});
