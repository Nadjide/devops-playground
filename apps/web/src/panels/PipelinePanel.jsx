import { GitBranch, Play } from 'lucide-react';
import { StatusBadge } from '../components/StatusBadge.jsx';

const stages = ['validate', 'test', 'build', 'deploy', 'verify'];

export function PipelinePanel() {
  return (
    <div className="pipeline-panel">
      <div className="pipeline-head">
        <span className="pipeline-label"><GitBranch aria-hidden="true" size={15} /> Simulated pipeline</span>
        <button type="button" className="button" aria-disabled="true" data-tooltip="Pipeline runs are unavailable in this session">
          <Play aria-hidden="true" size={14} /> Run pipeline
        </button>
      </div>
      <ol className="stage-list" aria-label="Pipeline stages">
        {stages.map((stage) => (
          <li key={stage} className="stage">
            <span className="stage-name">{stage}</span>
            <StatusBadge value="pending" />
          </li>
        ))}
      </ol>
      <p className="muted small">
        No pipeline run recorded. This workbench pipeline is separate from the repository GitHub Actions workflow.
      </p>
    </div>
  );
}
