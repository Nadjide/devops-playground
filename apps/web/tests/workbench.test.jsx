import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App.jsx';
import { createTestClient, renderApp } from './helpers.jsx';
import { setDesktopViewport } from './setup.js';

describe('workbench shell', () => {
  it('shows the project name, demo mode, connection, and selected mission', async () => {
    await renderApp();
    expect(screen.getByRole('heading', { level: 1, name: 'DevOps Playground' })).toBeInTheDocument();
    expect(screen.getByText('Demo mode')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Simulator ready');
    expect(screen.getByRole('heading', { name: 'Restore the API' })).toBeInTheDocument();
    expect(screen.getAllByText('Pending')).toHaveLength(3);
  });

  it('renders the loading state before the session is ready', () => {
    const client = createTestClient();
    render(<App client={client} />);
    expect(screen.getByText(/Preparing the demo session/)).toBeInTheDocument();
  });

  it('renders the error state with a retry action', async () => {
    const client = createTestClient({ labId: 'missing-lab' });
    await renderApp({ client });
    expect(screen.getByRole('alert')).toHaveTextContent('The session could not start');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('switches desktop panels with tab semantics and arrow keys', async () => {
    const user = userEvent.setup();
    await renderApp();
    const operations = screen.getByRole('tablist', { name: 'Operations panels' });
    const docker = within(operations).getByRole('tab', { name: 'Docker' });
    const pipeline = within(operations).getByRole('tab', { name: 'Pipeline' });
    expect(docker).toHaveAttribute('aria-selected', 'true');
    expect(pipeline).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('heading', { name: 'Docker containers' })).toBeInTheDocument();

    docker.focus();
    await user.keyboard('{ArrowRight}');
    expect(pipeline).toHaveAttribute('aria-selected', 'true');
    expect(pipeline).toHaveFocus();
    expect(screen.getByRole('heading', { name: 'Delivery pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Pipeline' })).toBeInTheDocument();

    await user.keyboard('{Home}');
    expect(docker).toHaveFocus();
    await user.click(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByRole('list', { name: 'Orchestration events' })).toHaveTextContent('session.status-changed');
  });

  it('keeps unavailable actions focusable and explained', async () => {
    await renderApp();
    const start = screen.getByRole('button', { name: 'Start api' });
    expect(start).not.toHaveAttribute('aria-disabled');
    expect(screen.getByText('stopped')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Pipeline' }));
    const run = screen.getByRole('button', { name: 'Run pipeline' });
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).toHaveAttribute('data-tooltip', 'Pipeline runs are unavailable in this session');
  });

  it('moves focus into the session menu and restores it on Escape', async () => {
    const user = userEvent.setup();
    await renderApp();
    const trigger = screen.getByRole('button', { name: /Session/ });
    await user.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Session actions' });
    expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus();
    expect(within(menu).getByRole('menuitem', { name: /Reset session/ })).not.toHaveAttribute('aria-disabled');
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: /End session/ })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('uses one tab list on compact viewports', async () => {
    setDesktopViewport(false);
    const user = userEvent.setup();
    await renderApp();
    const tabs = screen.getByRole('tablist', { name: 'Workbench panels' });
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent))
      .toEqual(['Mission', 'Docker', 'Monitoring', 'Logs', 'Terminal', 'Pipeline', 'Events']);
    expect(within(tabs).getByRole('tab', { name: 'Mission' })).toHaveAttribute('aria-selected', 'true');
    await user.click(within(tabs).getByRole('tab', { name: 'Docker' }));
    expect(screen.getByRole('heading', { name: 'Docker containers' })).toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('removes store subscriptions when the workbench unmounts', async () => {
    const { client, unmount } = await renderApp();
    expect(client.listenerCount()).toBeGreaterThan(0);
    unmount();
    expect(client.listenerCount()).toBe(0);
  });
});
