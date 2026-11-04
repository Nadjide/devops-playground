import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SIMULATED_TIMINGS } from '@devops-playground/lab-core';
import { renderApp } from './helpers.jsx';

const user = () => userEvent.setup({ advanceTimers: () => {} });

describe('simulated Docker and Monitoring panels', () => {
  it('shows pending work without replacing observed state, then the running container', async () => {
    const { advance } = await renderApp();
    await user().click(screen.getByRole('button', { name: 'Start api' }));
    expect(screen.getByRole('button', { name: 'Start api' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/Start api \((queued|running)\)/)).toBeInTheDocument();

    await advance(SIMULATED_TIMINGS.startup);
    const containers = screen.getByRole('list', { name: 'Session containers' });
    expect(within(containers).getByText('running')).toBeInTheDocument();
    expect(screen.getByTestId('operation-announcer')).toHaveTextContent('Start api succeeded.');

    await advance(SIMULATED_TIMINGS.healthcheck);
    expect(within(containers).getByText('healthy')).toBeInTheDocument();
  });

  it('renders a failed probe while the service is stopped', async () => {
    const { advance } = await renderApp();
    await user().click(screen.getByRole('button', { name: 'Probe /health' }));
    await advance(SIMULATED_TIMINGS.probe);
    const availability = screen.getByRole('article', { name: 'Workload availability' });
    expect(within(availability).getByText('Unavailable')).toBeInTheDocument();
    expect(within(availability).getByText(/ECONNREFUSED api:3000/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Probe history' })).toHaveTextContent('GET :3000/health');
    expect(screen.getByTestId('operation-announcer')).toHaveTextContent('Health probe api failed.');
  });

  it('drives Docker and Monitoring from the same snapshot after start and probe', async () => {
    const { advance, client } = await renderApp();
    await user().click(screen.getByRole('button', { name: 'Start api' }));
    await advance(SIMULATED_TIMINGS.startup);
    await user().click(screen.getByRole('button', { name: 'Probe /health' }));
    await user().click(screen.getByRole('button', { name: 'Probe /version' }));
    await advance(SIMULATED_TIMINGS.probe);

    const availability = screen.getByRole('article', { name: 'Workload availability' });
    expect(within(availability).getByText('Available')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Last health response' })).toHaveTextContent('"service": "devops-playground"');
    expect(screen.getByRole('article', { name: 'Observed version' })).toHaveTextContent('1.0.0');
    const { revision } = client.getSnapshot().session;
    expect(screen.getByText(new RegExp(`Snapshot revision ${revision} `))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`snapshot revision ${revision}\\.`))).toBeInTheDocument();
  });

  it('shows the approved configuration and observed details on inspect', async () => {
    const { advance } = await renderApp();
    await user().click(screen.getByRole('button', { name: 'Inspect api' }));
    await advance(SIMULATED_TIMINGS.inspect);
    const inspect = screen.getByRole('region', { name: 'Inspect result for api' });
    expect(inspect).toHaveTextContent('devops-playground-lab/api:1.0.0');
    expect(inspect).toHaveTextContent('expectedProbePort 3000 (read-only)');
    expect(inspect).toHaveTextContent('stopped (exit 0)');
    await user().click(within(inspect).getByRole('button', { name: 'Close inspect result' }));
    expect(screen.queryByRole('region', { name: 'Inspect result for api' })).not.toBeInTheDocument();
  });

  it('confirms reset in a focus-trapped dialog and starts a new generation', async () => {
    const actor = user();
    const { settle, client } = await renderApp();
    await actor.click(screen.getByRole('button', { name: 'Start api' }));
    await settle();

    const trigger = screen.getByRole('button', { name: /Session/ });
    await actor.click(trigger);
    await actor.click(screen.getByRole('menuitem', { name: /Reset session/ }));
    const dialog = screen.getByRole('dialog', { name: 'Reset this session?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await actor.keyboard('{Tab}');
    expect(within(dialog).getByRole('button', { name: 'Reset session' })).toHaveFocus();
    await actor.keyboard('{Tab}');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await actor.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(client.getSnapshot().session.generation).toBe(1);

    await actor.click(trigger);
    await actor.click(screen.getByRole('menuitem', { name: /Reset session/ }));
    await actor.click(screen.getByRole('button', { name: 'Reset session' }));
    await settle();
    expect(client.getSnapshot().session).toMatchObject({ generation: 2, status: 'active' });
    expect(within(screen.getByRole('list', { name: 'Session containers' })).getByText('stopped')).toBeInTheDocument();
  });

  it('ends the session and offers a new one', async () => {
    const actor = user();
    const { settle, client } = await renderApp();
    await actor.click(screen.getByRole('button', { name: /Session/ }));
    await actor.click(screen.getByRole('menuitem', { name: /End session/ }));
    await actor.click(screen.getByRole('button', { name: 'End session' }));
    await settle();
    expect(screen.getByText('This session has ended and its resources were removed.')).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Start a new session' }));
    await settle();
    expect(client.getSnapshot().session.status).toBe('active');
  });
});
