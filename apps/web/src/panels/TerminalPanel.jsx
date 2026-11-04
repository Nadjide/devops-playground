import { SquareTerminal } from 'lucide-react';
import { EmptyState } from '../components/EmptyState.jsx';

export function TerminalPanel() {
  return (
    <EmptyState icon={SquareTerminal} title="Command terminal unavailable">
      The validated workbench command interface is not available in this session.
    </EmptyState>
  );
}
