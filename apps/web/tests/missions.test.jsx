import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { runTerminalCommand } from '../src/terminal/commands.js';
import { createTestClient, renderApp } from './helpers.jsx';
import { setDesktopViewport } from './setup.js';

const sidebar = () => screen.getByRole('complementary', { name: 'Mission' });
const objectiveItem = (label) => screen.getByText(label).closest('li');

async function typeInto(actor, input, text) {
  // jsdom has no layout, so pointer hit-testing would focus a panel separator.
  input.focus();
  await actor.clear(input);
  await actor.type(input, text, { skipClick: true });
}

describe('mission catalog and progress', () => {
  it('offers only the missions the simulator can run', async () => {
    await renderApp();
    const select = screen.getByRole('combobox', { name: 'Mission' });
    expect(within(select).getAllByRole('option').map((option) => option.value))
      .toEqual(['stopped-container', 'wrong-port', 'broken-release', 'storage-provision', 'storage-config', 'free-exploration']);
  });

  it('completes M01 through visible controls and shows the evidence', async () => {
    const actor = userEvent.setup();
    const { settle } = await renderApp();
    await actor.click(screen.getByRole('button', { name: 'Read logs of api' }));
    await settle();
    expect(within(objectiveItem('Inspect the service logs')).getByText('Satisfied')).toBeInTheDocument();

    await actor.click(screen.getByRole('button', { name: 'Start api' }));
    await settle();
    expect(within(objectiveItem('Run the API container')).getByText('Satisfied')).toBeInTheDocument();
    expect(within(objectiveItem('Verify a successful health response')).getByText('Pending')).toBeInTheDocument();

    await actor.click(screen.getByRole('button', { name: 'Probe /health' }));
    await settle();
    const status = within(sidebar()).getByRole('status');
    expect(status).toHaveTextContent('Mission complete');
    const health = objectiveItem('Verify a successful health response');
    await actor.click(within(health).getByText('Evidence'));
    expect(health).toHaveTextContent(/returned 200 with status ok/);
    expect(health).toHaveTextContent('Simulated');
  });

  it('completes M01 equally through terminal commands', async () => {
    const client = createTestClient();
    await client.ready;
    const run = async (input) => {
      const pending = runTerminalCommand(input, { client, requestLifecycle: () => {} });
      await client.clock.runAll();
      return pending;
    };
    await run('docker logs api');
    await run('docker start api');
    await run('curl http://api:3000/health');
    expect(client.getSnapshot().session.mission).toMatchObject({ status: 'completed' });
  });

  it('reveals hints progressively and the solution only on request', async () => {
    const actor = userEvent.setup();
    await renderApp();
    const guidance = screen.getByRole('region', { name: 'Hints and solution' });
    expect(within(guidance).queryByRole('listitem')).not.toBeInTheDocument();
    await actor.click(within(guidance).getByRole('button', { name: 'Show hint 1 of 3' }));
    expect(within(guidance).getAllByRole('listitem')).toHaveLength(1);
    await actor.click(within(guidance).getByRole('button', { name: 'Show hint 2 of 3' }));
    expect(within(guidance).getAllByRole('listitem')).toHaveLength(2);
    expect(within(guidance).queryByRole('list', { name: 'Solution steps' })).not.toBeInTheDocument();
    await actor.click(within(guidance).getByRole('button', { name: 'Reveal the solution…' }));
    await actor.click(within(guidance).getByRole('button', { name: 'Keep hidden' }));
    expect(within(guidance).queryByRole('list', { name: 'Solution steps' })).not.toBeInTheDocument();
    await actor.click(within(guidance).getByRole('button', { name: 'Reveal the solution…' }));
    await actor.click(within(guidance).getByRole('button', { name: 'Show solution' }));
    expect(within(guidance).getByRole('list', { name: 'Solution steps' })).toHaveTextContent('docker start api');
  });

  it('switches mission only after confirmation and keeps focus on the selector', async () => {
    const actor = userEvent.setup();
    const { client } = await renderApp();
    const select = screen.getByRole('combobox', { name: 'Mission' });
    await actor.selectOptions(select, 'wrong-port');
    const dialog = screen.getByRole('dialog', { name: 'Start a new session?' });
    expect(dialog).toHaveTextContent('Fix a port configuration');
    await actor.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(client.getSnapshot().session.labId).toBe('stopped-container');
    expect(select).toHaveFocus();

    await actor.selectOptions(select, 'wrong-port');
    await actor.click(screen.getByRole('button', { name: 'Start new session' }));
    await vi_waitForLab(client, 'wrong-port');
    expect(screen.getByRole('heading', { name: 'Fix a port configuration' })).toBeInTheDocument();
  });
});

async function vi_waitForLab(client, labId) {
  for (let attempt = 0; attempt < 50 && client.getSnapshot().session?.labId !== labId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(client.getSnapshot().session.labId).toBe(labId);
}

describe('M02 configuration controls', () => {
  it('validates appPort locally and completes after applying the expected port', async () => {
    // Compact layout: jsdom has no geometry, so desktop separators would capture pointer input.
    setDesktopViewport(false);
    const actor = userEvent.setup();
    const client = createTestClient({ labId: 'wrong-port' });
    const { settle } = await renderApp({ client });
    const tabs = screen.getByRole('tablist', { name: 'Workbench panels' });
    await actor.click(within(tabs).getByRole('tab', { name: 'Docker' }));
    const form = screen.getByRole('form', { name: 'api configuration' });
    const input = within(form).getByLabelText('appPort');
    expect(input).toHaveValue('3001');
    expect(form).toHaveTextContent('expectedProbePort 3000 is set by the lab and read-only');

    // Keyboard submission: jsdom pointer hit-testing lets the panel library cancel clicks.
    await typeInto(actor, input, '80{Enter}');
    expect(within(form).getByRole('alert')).toHaveTextContent('appPort must be an integer from 1024 to 65535.');
    expect(client.getSnapshot().session.operations).toHaveLength(0);

    await actor.click(screen.getByRole('button', { name: 'Inspect api' }));
    await typeInto(actor, input, '3000{Enter}');
    await settle();
    expect(client.getSnapshot().session.resources[0].desired.appPort).toBe(3000);
    await actor.click(within(tabs).getByRole('tab', { name: 'Monitoring' }));
    await actor.click(screen.getByRole('button', { name: 'Probe /health' }));
    await settle();
    await actor.click(within(tabs).getByRole('tab', { name: 'Mission' }));
    expect(within(objectiveItem('Run the API on the expected probe port 3000')).getByText('Satisfied')).toBeInTheDocument();
    expect(screen.getByText('Mission complete')).toBeInTheDocument();
  });
});

describe('free exploration', () => {
  it('changes fixtures through a confirmed new session', async () => {
    const actor = userEvent.setup();
    const client = createTestClient({ labId: 'free-exploration' });
    await renderApp({ client });
    expect(screen.queryByText('Objectives')).not.toBeInTheDocument();
    const fixture = screen.getByRole('combobox', { name: /Starting fixture/ });
    expect(fixture).toHaveValue('api-running');
    await actor.selectOptions(fixture, 'api-wrong-port');
    await actor.click(screen.getByRole('button', { name: 'Start new session' }));
    for (let attempt = 0; attempt < 50 && client.getSnapshot().session?.fixtureId !== 'api-wrong-port'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(client.getSnapshot().session).toMatchObject({ labId: 'free-exploration', fixtureId: 'api-wrong-port' });
  });
});
