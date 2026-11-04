import { Activity, Container, GitBranch, ListTree, ScrollText, SquareTerminal, Target } from 'lucide-react';
import { DockerPanel } from './DockerPanel.jsx';
import { MonitoringPanel } from './MonitoringPanel.jsx';
import { LogsPanel } from './LogsPanel.jsx';
import { EventsPanel } from './EventsPanel.jsx';
import { LazyTerminalPanel } from './LazyTerminalPanel.jsx';
import { PipelinePanel } from './PipelinePanel.jsx';

export const panels = {
  docker: { id: 'docker', title: 'Docker', heading: 'Docker containers', icon: Container, Component: DockerPanel },
  pipeline: { id: 'pipeline', title: 'Pipeline', heading: 'Delivery pipeline', icon: GitBranch, Component: PipelinePanel },
  monitoring: { id: 'monitoring', title: 'Monitoring', heading: 'Workload monitoring', icon: Activity, Component: MonitoringPanel },
  logs: { id: 'logs', title: 'Logs', heading: 'Workload logs', icon: ScrollText, Component: LogsPanel },
  terminal: { id: 'terminal', title: 'Terminal', heading: 'Command terminal', icon: SquareTerminal, Component: LazyTerminalPanel },
  events: { id: 'events', title: 'Events', heading: 'Orchestration events', icon: ListTree, Component: EventsPanel },
};

export const missionTab = { id: 'mission', title: 'Mission', icon: Target };

export const desktopGroups = {
  primary: { label: 'Operations panels', panels: ['docker', 'pipeline'] },
  secondary: { label: 'Observation panels', panels: ['monitoring', 'logs'] },
  drawer: { label: 'Terminal and events', panels: ['terminal', 'events'] },
};

export const compactOrder = ['mission', 'docker', 'monitoring', 'logs', 'terminal', 'pipeline', 'events'];
