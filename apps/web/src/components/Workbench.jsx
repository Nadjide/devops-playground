import { useCallback, useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { AlertTriangle, ChevronDown, ChevronUp, LoaderCircle } from 'lucide-react';
import { getLabManifest } from '@devops-playground/lab-core';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import { useSessionActions } from '../session/SessionActions.jsx';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { isLayout, useLayoutPreference } from '../hooks/useLayoutPreference.js';
import { compactOrder, desktopGroups, missionTab, panels } from '../panels/registry.js';
import { PanelFrame } from '../panels/PanelFrame.jsx';
import { MissionSidebar } from './MissionSidebar.jsx';
import { TabPanel, Tabs } from './Tabs.jsx';

export const DESKTOP_QUERY = '(min-width: 1024px)';

function PanelArea({ groupId, selected, onSelect, toolbar = null }) {
  const group = desktopGroups[groupId];
  const panel = panels[selected];
  const Component = panel.Component;
  return (
    <div className="panel-area" data-group={groupId}>
      <div className="panel-area-bar">
        <Tabs
          id={groupId}
          label={group.label}
          items={group.panels.map((id) => panels[id])}
          selectedId={selected}
          onSelect={onSelect}
        />
        {toolbar}
      </div>
      <TabPanel id={groupId} itemId={selected}>
        <PanelFrame id={`${groupId}-${selected}`} title={panel.heading}>
          <Component />
        </PanelFrame>
      </TabPanel>
    </div>
  );
}

const validSelection = (value) => value && Object.entries(desktopGroups).every(([groupId, group]) => group.panels.includes(value[groupId]));

function DesktopWorkbench() {
  const [selection, setSelection] = useLayoutPreference('desktopSelection',
    { primary: 'docker', secondary: 'monitoring', drawer: 'terminal' }, validSelection);
  const [columns, setColumns] = useLayoutPreference('desktopColumns', null, isLayout(['workspace-primary', 'workspace-secondary']));
  const [rows, setRows] = useLayoutPreference('desktopRows', null, isLayout(['workspace-main', 'workspace-drawer']));
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const drawerRef = useRef(null);
  const select = (groupId) => (panelId) => setSelection((current) => ({ ...current, [groupId]: panelId }));

  const toggleDrawer = useCallback(() => {
    const drawer = drawerRef.current;
    if (!drawer) {
      return;
    }
    if (drawer.isCollapsed()) {
      drawer.expand();
    } else {
      drawer.collapse();
    }
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.ctrlKey && event.key === '`') {
        event.preventDefault();
        toggleDrawer();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleDrawer]);

  const DrawerIcon = drawerCollapsed ? ChevronUp : ChevronDown;

  return (
    <div className="workbench workbench-desktop">
      <aside className="sidebar" aria-label="Mission">
        <MissionSidebar />
      </aside>
      <main className="workspace" aria-label="Workspace">
        <Group
          orientation="vertical"
          className="panel-group"
          defaultLayout={rows ?? undefined}
          onLayoutChanged={(layout, meta) => meta?.isUserInteraction && setRows(layout)}
        >
          <Panel id="workspace-main" minSize="30%">
            <Group
              orientation="horizontal"
              className="panel-group"
              defaultLayout={columns ?? undefined}
              onLayoutChanged={(layout, meta) => meta?.isUserInteraction && setColumns(layout)}
            >
              <Panel id="workspace-primary" defaultSize="56%" minSize="30%">
                <PanelArea groupId="primary" selected={selection.primary} onSelect={select('primary')} />
              </Panel>
              <Separator className="separator separator-columns" aria-label="Resize operations and observation panels" />
              <Panel id="workspace-secondary" minSize="25%">
                <PanelArea groupId="secondary" selected={selection.secondary} onSelect={select('secondary')} />
              </Panel>
            </Group>
          </Panel>
          <Separator className="separator separator-rows" aria-label="Resize terminal and events drawer" />
          <Panel
            id="workspace-drawer"
            panelRef={drawerRef}
            defaultSize="32%"
            minSize="18%"
            collapsible
            collapsedSize={44}
            onResize={() => setDrawerCollapsed(Boolean(drawerRef.current?.isCollapsed()))}
          >
            <PanelArea
              groupId="drawer"
              selected={selection.drawer}
              onSelect={(panelId) => {
                select('drawer')(panelId);
                if (drawerRef.current?.isCollapsed()) {
                  drawerRef.current.expand();
                }
              }}
              toolbar={(
                <button
                  type="button"
                  className="icon-button"
                  aria-label={drawerCollapsed ? 'Open terminal and events' : 'Collapse terminal and events'}
                  aria-expanded={!drawerCollapsed}
                  data-tooltip={`${drawerCollapsed ? 'Open' : 'Collapse'} drawer (Ctrl+\`)`}
                  onClick={toggleDrawer}
                >
                  <DrawerIcon aria-hidden="true" size={16} />
                </button>
              )}
            />
          </Panel>
        </Group>
      </main>
    </div>
  );
}

function MissionSummary({ onOpen }) {
  const { session } = useSessionState();
  const lab = getLabManifest(session.labId);
  const satisfied = session.mission.objectives.filter((objective) => objective.status === 'satisfied').length;
  const detail = lab.kind === 'exploration'
    ? 'Free exploration'
    : `${satisfied}/${session.mission.objectives.length} objectives${session.mission.completion ? ' · complete' : ''}`;
  return (
    <button type="button" className="mission-summary" onClick={onOpen}>
      <span className="mission-summary-title">{lab.title}</span>
      <span className="muted small">{detail}</span>
    </button>
  );
}

function CompactWorkbench() {
  const [selected, setSelected] = useLayoutPreference('compactTab', 'mission', (value) => compactOrder.includes(value));
  const items = compactOrder.map((id) => (id === 'mission' ? missionTab : panels[id]));
  const panel = panels[selected];
  const Component = panel?.Component;
  return (
    <div className="workbench workbench-compact">
      <MissionSummary onOpen={() => setSelected('mission')} />
      <Tabs id="compact" label="Workbench panels" items={items} selectedId={selected} onSelect={setSelected} className="tablist-scroll" />
      <main className="compact-main" aria-label="Workspace">
        <TabPanel id="compact" itemId={selected}>
          {selected === 'mission' ? (
            <div className="compact-mission"><MissionSidebar /></div>
          ) : (
            <PanelFrame id={`compact-${selected}`} title={panel.heading}>
              <Component />
            </PanelFrame>
          )}
        </TabPanel>
      </main>
    </div>
  );
}

export function Workbench() {
  const client = useSessionClient();
  const state = useSessionState();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  if (state.status === 'loading') {
    return (
      <div className="state-screen" role="status">
        <LoaderCircle aria-hidden="true" className="spin" size={22} />
        <p>{state.loadingMessage ?? 'Preparing the demo session…'}</p>
      </div>
    );
  }

  if (state.status === 'unavailable') {
    return <LocalDiagnostics diagnostics={state.diagnostics} onRetry={() => client.retry()} />;
  }

  if (state.status === 'error') {
    return (
      <div className="state-screen" role="alert">
        <AlertTriangle aria-hidden="true" size={22} />
        <p>The session could not start: {state.error?.message}</p>
        <button type="button" className="button" onClick={() => client.retry()}>Retry</button>
      </div>
    );
  }

  return (
    <>
      <SessionBanner />
      {isDesktop ? <DesktopWorkbench /> : <CompactWorkbench />}
    </>
  );
}

function LocalDiagnostics({ diagnostics, onRetry }) {
  const docker = diagnostics?.docker;
  const runner = diagnostics?.runner;
  return (
    <main className="state-screen diagnostics" aria-labelledby="diagnostics-title">
      <h2 id="diagnostics-title">Local Docker diagnostics</h2>
      <dl className="diagnostics-list">
        <div><dt>Controller</dt><dd>Healthy (local mode)</dd></div>
        <div><dt>Runner</dt><dd>{runner?.status === 'connected' ? 'Connected' : `Unavailable: ${runner?.error?.message ?? 'not reachable'}`}</dd></div>
        <div>
          <dt>Docker</dt>
          <dd>{docker?.available ? `Engine ${docker.serverVersion} (API ${docker.apiVersion})` : (docker?.error?.message ?? 'Not checked')}</dd>
        </div>
        <div><dt>Labs</dt><dd>{diagnostics?.labs?.length ? `${diagnostics.labs.length} available` : 'No local lab can run on this backend yet.'}</dd></div>
      </dl>
      <p className="small">Local execution never falls back to simulation. The browser demo stays available from the static build.</p>
      <button type="button" className="button" onClick={onRetry}>Check again</button>
    </main>
  );
}

function SessionBanner() {
  const client = useSessionClient();
  const { session, recovery, restored } = useSessionState();
  const { requestLifecycle } = useSessionActions();
  if (recovery) {
    return (
      <div className="banner banner-danger" role="alert">
        <AlertTriangle aria-hidden="true" size={14} />
        <span>Saved progress could not be restored: {recovery.message} A new session was started instead.</span>
        <button type="button" className="button" onClick={() => client.discardSavedProgress()}>Discard saved progress</button>
        <button type="button" className="button button-quiet" onClick={() => client.continueWithoutSaving()}>Continue without saving</button>
      </div>
    );
  }
  if (session.status === 'ended') {
    return (
      <div className="banner banner-neutral" role="status">
        <span>This session has ended and its resources were removed.</span>
        <button type="button" className="button" onClick={() => client.retry()}>Start a new session</button>
      </div>
    );
  }
  if (session.status === 'resetting' || session.status === 'ending') {
    return (
      <div className="banner banner-warning" role="status">
        <LoaderCircle aria-hidden="true" size={14} className="spin" />
        <span>{session.status === 'resetting' ? 'Resetting the session…' : 'Ending the session…'}</span>
      </div>
    );
  }
  if (restored && session.status === 'active') {
    return (
      <div className="banner banner-neutral" role="status">
        <span>Restored your saved demo session (generation {session.generation}). Work that was running when the page closed was cancelled.</span>
        <button type="button" className="button" onClick={(event) => requestLifecycle('session.reset', { returnFocus: event.currentTarget })}>Reset session</button>
      </div>
    );
  }
  if (session.status === 'degraded') {
    return (
      <div className="banner banner-danger" role="alert">
        <AlertTriangle aria-hidden="true" size={14} />
        <span>The session is degraded after a failed lifecycle operation.</span>
        <button
          type="button"
          className="button"
          onClick={(event) => requestLifecycle('session.reset', { returnFocus: event.currentTarget })}
        >
          Retry reset
        </button>
      </div>
    );
  }
  return null;
}
