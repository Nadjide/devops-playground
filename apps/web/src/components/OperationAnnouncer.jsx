import { useSessionState } from '../session/SessionContext.jsx';
import { describeOperation } from '../session/operations.js';

const verbs = { succeeded: 'succeeded', failed: 'failed', cancelled: 'was cancelled' };

/** Polite live region that announces only the latest finished operation. */
export function OperationAnnouncer() {
  const { events } = useSessionState();
  const latest = events.findLast((event) => ['operation.succeeded', 'operation.failed', 'operation.cancelled']
    .includes(event.type));
  let message = '';
  if (latest) {
    const { operation } = latest.payload;
    message = `${describeOperation(operation)} ${verbs[operation.status]}.`;
    if (operation.error) {
      message += ` ${operation.error.message}`;
    }
  }
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="operation-announcer">
      {message}
    </div>
  );
}
