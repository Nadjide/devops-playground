import { useRef, useState } from 'react';
import { CheckCircle2, Circle, CircleAlert, Compass, Eye, Lightbulb, PartyPopper, Target } from 'lucide-react';
import { getFixture, getLabManifest } from '@devops-playground/lab-core';
import { useSessionState } from '../session/SessionContext.jsx';
import { useSessionActions } from '../session/SessionActions.jsx';
import { StatusBadge } from './StatusBadge.jsx';
import { formatTime, sourceLabel } from './format.js';

const objectiveIcons = { pending: Circle, satisfied: CheckCircle2, invalidated: CircleAlert };
const objectiveText = { pending: 'Pending', satisfied: 'Satisfied', invalidated: 'Invalidated' };

function Evidence({ evidence, status }) {
  if (!evidence) {
    return null;
  }
  return (
    <details className="evidence">
      <summary>{status === 'invalidated' ? 'Previous evidence' : 'Evidence'}</summary>
      <p>{evidence.explanation}</p>
      <dl className="evidence-facts">
        <div><dt>Observed</dt><dd>{formatTime(evidence.observedAt)}</dd></div>
        <div><dt>Source</dt><dd>{sourceLabel(evidence.source)}</dd></div>
        <div><dt>Revision</dt><dd>{evidence.revision} (generation {evidence.generation})</dd></div>
        <div><dt>Event</dt><dd className="mono">#{evidence.eventId.split(':').at(-1)}</dd></div>
      </dl>
    </details>
  );
}

function Guidance({ lab, sessionKey }) {
  const [state, setState] = useState({ key: sessionKey, hints: 0, solution: 'hidden' });
  // Revealed guidance belongs to one session generation.
  const current = state.key === sessionKey ? state : { key: sessionKey, hints: 0, solution: 'hidden' };
  const hints = lab.hints ?? [];
  const update = (patch) => setState({ ...current, ...patch });

  if (hints.length === 0 && !lab.solution) {
    return null;
  }
  return (
    <section className="guidance" aria-label="Hints and solution">
      <h3 className="section-label">Hints</h3>
      {current.hints > 0 ? (
        <ol className="hint-list">
          {hints.slice(0, current.hints).map((hint, index) => <li key={hint}><span className="hint-number">{index + 1}</span>{hint}</li>)}
        </ol>
      ) : <p className="small muted">Hints are revealed one at a time when you ask for them.</p>}
      {current.hints < hints.length ? (
        <button type="button" className="button" onClick={() => update({ hints: current.hints + 1 })}>
          <Lightbulb aria-hidden="true" size={14} /> Show hint {current.hints + 1} of {hints.length}
        </button>
      ) : null}
      {lab.solution ? (
        <div className="solution">
          {current.solution === 'hidden' ? (
            <button type="button" className="link-button" onClick={() => update({ solution: 'confirm' })}>Reveal the solution…</button>
          ) : null}
          {current.solution === 'confirm' ? (
            <p className="solution-confirm" role="group" aria-label="Confirm solution reveal">
              <span className="small">Show the complete solution? Trying the hints first is more instructive.</span>
              <button type="button" className="button" onClick={() => update({ solution: 'shown' })}>
                <Eye aria-hidden="true" size={14} /> Show solution
              </button>
              <button type="button" className="button button-quiet" onClick={() => update({ solution: 'hidden' })}>Keep hidden</button>
            </p>
          ) : null}
          {current.solution === 'shown' ? (
            <ol className="solution-steps" aria-label="Solution steps">
              {lab.solution.map((step) => <li key={step} className="mono">{step}</li>)}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function FixturePicker({ lab, session }) {
  const { requestSessionChange } = useSessionActions();
  const selectRef = useRef(null);
  return (
    <label className="field-stack">
      <span>Starting fixture</span>
      <select
        ref={selectRef}
        value={session.fixtureId}
        onChange={(event) => requestSessionChange(
          { labId: lab.id, fixtureId: event.target.value, fixtureLabel: getFixture(event.target.value).label },
          { returnFocus: selectRef.current },
        )}
      >
        {lab.fixtureOptions.map((fixtureId) => <option key={fixtureId} value={fixtureId}>{getFixture(fixtureId).label}</option>)}
      </select>
      <span className="small muted">Changing the fixture starts a new session. Reset returns to the selected fixture.</span>
    </label>
  );
}

export function MissionSidebar({ headingLevel = 2 }) {
  const { session } = useSessionState();
  if (!session) {
    return null;
  }
  const lab = getLabManifest(session.labId);
  const Heading = `h${headingLevel}`;
  const exploration = lab.kind === 'exploration';
  const progress = new Map(session.mission.objectives.map((objective) => [objective.id, objective]));
  const satisfied = session.mission.objectives.filter((objective) => objective.status === 'satisfied').length;
  const { completion } = session.mission;
  const degradedSinceCompletion = completion && session.mission.objectives.some((objective) => objective.status !== 'satisfied');

  return (
    <section className="mission" aria-labelledby="mission-title">
      <p className="eyebrow">
        {exploration ? <Compass aria-hidden="true" size={14} /> : <Target aria-hidden="true" size={14} />}
        {exploration ? 'Exploration' : 'Mission'} · {lab.difficulty} · about {lab.estimatedMinutes} min
      </p>
      <Heading id="mission-title" className="mission-title">{lab.title}</Heading>
      <p className="mission-description">{lab.description}</p>

      {exploration ? (
        <FixturePicker lab={lab} session={session} />
      ) : (
        <>
          <div className="mission-status">
            <StatusBadge value={session.mission.status} label={session.mission.status.replace('-', ' ')} prefix="Mission status" />
            <span className="small muted">{satisfied}/{lab.objectives.length} objectives satisfied</span>
          </div>
          {completion ? (
            <div className="completion" role="status">
              <PartyPopper aria-hidden="true" size={16} />
              <div>
                <p className="completion-title">Mission complete</p>
                <p className="small">
                  Every required objective held at revision {completion.revision} ({formatTime(completion.completedAt)}).
                  {degradedSinceCompletion ? ' The current service state has changed since then.' : ''}
                </p>
              </div>
            </div>
          ) : null}
          <h3 className="section-label">Objectives</h3>
          <ol className="objectives">
            {lab.objectives.map((objective) => {
              const item = progress.get(objective.id);
              const status = item?.status ?? 'pending';
              const Icon = objectiveIcons[status];
              return (
                <li key={objective.id} className={`objective objective-${status}`}>
                  <Icon aria-hidden="true" size={18} className="objective-icon" />
                  <span className="objective-label">{objective.label}</span>
                  <span className="objective-status">{objectiveText[status]}{objective.required ? '' : ' · optional'}</span>
                  <Evidence evidence={item?.evidence} status={status} />
                </li>
              );
            })}
          </ol>
          <p className="muted small">Objectives are satisfied by observed technical evidence, not by clicks.</p>
          <Guidance lab={lab} sessionKey={`${session.id}:${session.generation}`} />
        </>
      )}
    </section>
  );
}
