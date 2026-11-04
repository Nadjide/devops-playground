import { useSessionState } from '../session/SessionContext.jsx';
import { describeOperation, operationLabels } from '../session/operations.js';
import { StatusBadge } from './StatusBadge.jsx';
import { formatTime } from './format.js';

/**
 * Recent operations and rejected requests for a set of operation types.
 * Pending work is shown separately from observed resource state.
 */
export function RecentOperations({ types, label, limit = 5 }) {
  const { session, notices } = useSessionState();
  const operations = (session?.operations ?? []).filter((operation) => types.includes(operation.type)).slice(-limit).reverse();
  const rejected = (notices ?? []).filter((notice) => types.includes(notice.type)).slice(-2).reverse();

  if (operations.length === 0 && rejected.length === 0) {
    return null;
  }

  return (
    <section className="recent-operations" aria-label={label}>
      <h3 className="section-label">{label}</h3>
      <ol className="operation-list">
        {rejected.map((notice) => (
          <li key={notice.id} className="operation-row">
            <StatusBadge value="failed" label="rejected" />
            <span>{operationLabels[notice.type] ?? notice.type}</span>
            <span className="operation-detail">{notice.message}</span>
          </li>
        ))}
        {operations.map((operation) => (
          <li key={operation.id} className="operation-row">
            <StatusBadge value={operation.status} />
            <span>{describeOperation(operation, session)}</span>
            <span className="operation-detail">
              {operation.error ? operation.error.message : formatTime(operation.finishedAt ?? operation.startedAt)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
