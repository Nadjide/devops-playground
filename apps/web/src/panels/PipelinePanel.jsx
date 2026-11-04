import { useState } from 'react';
import { CircleStop, GitBranch, History, Play, Undo2 } from 'lucide-react';
import { getFixture, getReleaseById, isCancellable } from '@devops-playground/lab-core';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import { isActive, useOperationDispatch } from '../session/operations.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { RecentOperations } from '../components/RecentOperations.jsx';
import { formatTime, sourceLabel } from '../components/format.js';

const PIPELINE_TYPES = ['pipeline.run', 'pipeline.rollback', 'pipeline.cancel'];

function duration(ms) {
  if (ms === null) {
    return '—';
  }
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function ActionButton({ icon: Icon, label, unavailableReason, onClick, tone = '' }) {
  return (
    <button
      type="button"
      className={`button ${tone}`}
      aria-disabled={Boolean(unavailableReason) || undefined}
      data-tooltip={unavailableReason ?? undefined}
      onClick={() => {
        if (!unavailableReason) {
          onClick();
        }
      }}
    >
      <Icon aria-hidden="true" size={14} /> {label}
    </button>
  );
}

function RunDetails({ run }) {
  const fallback = run.stages.find((stage) => stage.status === 'running' || stage.status === 'failed') ??
    run.stages.findLast((stage) => stage.logs.length > 0) ?? run.stages[0];
  const [selected, setSelected] = useState(null);
  const stage = run.stages.find((item) => item.id === selected) ?? fallback;

  return (
    <section className="pipeline-run" aria-label={`Run ${run.kind} ${run.release.version}`}>
      <header className="pipeline-run-head">
        <h3>{run.kind === 'rollback' ? 'Rollback' : 'Deploy'} {run.release.version}</h3>
        <StatusBadge value={run.status} />
        <span className="small muted">started {formatTime(run.startedAt)}</span>
      </header>
      <ol className="stage-list" aria-label="Pipeline stages">
        {run.stages.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="stage"
              aria-pressed={item.id === stage.id}
              aria-label={`${item.id} ${item.status}`}
              onClick={() => setSelected(item.id)}
            >
              <span className="stage-name">{item.id}</span>
              <StatusBadge value={item.status} />
              <span className="small muted">{duration(item.durationMs)}</span>
            </button>
          </li>
        ))}
      </ol>
      {run.failureReason ? <p className="field-error" role="note">{run.failureReason}</p> : null}
      <div className="stage-logs">
        <p className="small muted">
          Stage <span className="mono">{stage.id}</span> logs
          {stage.exitCode !== null ? ` · exit code ${stage.exitCode}` : ''}
          {stage.source ? ` · ${sourceLabel(stage.source)}` : ''}
        </p>
        {stage.logs.length > 0 ? (
          <pre className="json-preview" aria-label={`${stage.id} stage logs`}>{stage.logs.join('\n')}</pre>
        ) : <p className="small muted">No output for this stage.</p>}
      </div>
    </section>
  );
}

export function PipelinePanel() {
  const client = useSessionClient();
  const { session } = useSessionState();
  const dispatch = useOperationDispatch();
  const fixture = getFixture(session.fixtureId);
  const [choice, setChoice] = useState({ fixtureId: session.fixtureId, releaseId: fixture.candidates[0] });
  const candidate = choice.fixtureId === session.fixtureId ? choice.releaseId : fixture.candidates[0];
  const { knownGood, deployed, runs } = session.pipeline;
  const latest = runs.at(-1) ?? null;
  const active = session.operations.find((operation) => ['pipeline.run', 'pipeline.rollback'].includes(operation.type) && isActive(operation));
  const allowed = client.isAvailable('pipeline.run');
  const onKnownGood = deployed && knownGood && deployed.releaseId === knownGood.releaseId && deployed.status === 'verified';
  const label = client.mode === 'local' ? 'Local pipeline' : 'Simulated pipeline';

  const runReason = !allowed ? 'Pipeline runs are unavailable in this session' : (active ? 'A pipeline run is in progress' : null);
  const cancelReason = !allowed ? 'Unavailable in this session'
    : (!active ? 'No run in progress' : (latest && !isCancellable(latest) ? 'Not safe once deploy has started' : null));
  const rollbackReason = !allowed ? 'Unavailable in this session'
    : (active ? 'A pipeline run is in progress' : (!knownGood ? 'No known-good release recorded' : (onKnownGood ? 'The known-good release is already verified' : null)));

  return (
    <div className="pipeline-panel">
      <div className="pipeline-head">
        <span className="pipeline-label"><GitBranch aria-hidden="true" size={15} /> {label}</span>
        <div className="pipeline-actions">
          {allowed && fixture.candidates.length > 1 ? (
            <label className="field-inline">
              <span>Candidate</span>
              <select value={candidate} onChange={(event) => setChoice({ fixtureId: session.fixtureId, releaseId: event.target.value })}>
                {fixture.candidates.map((releaseId) => (
                  <option key={releaseId} value={releaseId}>{getReleaseById(releaseId).version}</option>
                ))}
              </select>
            </label>
          ) : null}
          <ActionButton
            icon={Play}
            label={allowed ? `Run pipeline (${getReleaseById(candidate).version})` : 'Run pipeline'}
            tone="button-primary"
            unavailableReason={runReason}
            onClick={() => dispatch('pipeline.run', { releaseId: candidate })}
          />
          <ActionButton icon={CircleStop} label="Cancel run" unavailableReason={cancelReason} onClick={() => dispatch('pipeline.cancel')} />
          <ActionButton icon={Undo2} label="Roll back" unavailableReason={rollbackReason} onClick={() => dispatch('pipeline.rollback')} />
        </div>
      </div>

      <dl className="release-facts">
        <div>
          <dt>Deployed release</dt>
          <dd>{deployed ? <><span className="mono">{deployed.version}</span> <StatusBadge value={deployed.status} /></> : 'None recorded'}</dd>
        </div>
        <div>
          <dt>Last known-good</dt>
          <dd className="mono">{knownGood ? `${knownGood.version} (${knownGood.image})` : 'None recorded'}</dd>
        </div>
      </dl>

      {latest ? <RunDetails key={latest.id} run={latest} /> : (
        <p className="muted small">No pipeline run recorded{allowed ? '.' : '. Pipeline runs are not part of this mission.'}</p>
      )}

      {runs.length > 1 ? (
        <section aria-label="Run history">
          <h3 className="section-label"><History aria-hidden="true" size={13} /> Run history</h3>
          <ol className="operation-list">
            {[...runs].reverse().slice(1).map((run) => (
              <li key={run.id} className="operation-row">
                <StatusBadge value={run.status} />
                <span>{run.kind} {run.release.version}</span>
                <span className="operation-detail">{run.failureReason ?? formatTime(run.finishedAt ?? run.startedAt)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <RecentOperations types={PIPELINE_TYPES} label="Recent pipeline operations" limit={3} />
      <p className="muted small">
        Stage order: validate, test, build, deploy, verify. This workbench pipeline is separate from the repository GitHub Actions workflow.
      </p>
    </div>
  );
}
