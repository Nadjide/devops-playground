import { lazy, Suspense } from 'react';

// xterm is the largest dependency; load it only when the terminal is shown.
const TerminalPanel = lazy(() => import('./TerminalPanel.jsx').then((module) => ({ default: module.TerminalPanel })));

export function LazyTerminalPanel() {
  return (
    <Suspense fallback={<p className="muted small">Loading terminal…</p>}>
      <TerminalPanel />
    </Suspense>
  );
}
