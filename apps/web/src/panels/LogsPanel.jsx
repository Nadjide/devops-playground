import { ScrollText } from 'lucide-react';
import { EmptyState } from '../components/EmptyState.jsx';

export function LogsPanel() {
  return (
    <EmptyState icon={ScrollText} title="No workload log entries yet">
      Service logs appear here after the session reads them.
    </EmptyState>
  );
}
