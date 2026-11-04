import { CheckCircle2, Circle, CircleAlert, Target } from 'lucide-react';
import { getLabManifest } from '@devops-playground/lab-core';
import { useSessionState } from '../session/SessionContext.jsx';
import { StatusBadge } from './StatusBadge.jsx';

const objectiveIcons = { pending: Circle, satisfied: CheckCircle2, invalidated: CircleAlert };
const objectiveText = { pending: 'Pending', satisfied: 'Satisfied', invalidated: 'Invalidated' };

export function MissionSidebar({ headingLevel = 2 }) {
  const { session } = useSessionState();
  if (!session) {
    return null;
  }
  const lab = getLabManifest(session.labId);
  const Heading = `h${headingLevel}`;
  const progress = new Map(session.mission.objectives.map((objective) => [objective.id, objective]));

  return (
    <section className="mission" aria-labelledby="mission-title">
      <p className="eyebrow">
        <Target aria-hidden="true" size={14} />
        Mission · {lab.difficulty} · about {lab.estimatedMinutes} min
      </p>
      <Heading id="mission-title" className="mission-title">{lab.title}</Heading>
      <p className="mission-description">{lab.description}</p>
      <div className="mission-status">
        <StatusBadge value={session.mission.status} label={session.mission.status.replace('-', ' ')} prefix="Mission status" />
      </div>
      <h3 className="section-label">Objectives</h3>
      <ol className="objectives">
        {lab.objectives.map((objective) => {
          const status = progress.get(objective.id)?.status ?? 'pending';
          const Icon = objectiveIcons[status];
          return (
            <li key={objective.id} className={`objective objective-${status}`}>
              <Icon aria-hidden="true" size={18} className="objective-icon" />
              <span className="objective-label">{objective.label}</span>
              <span className="objective-status">{objectiveText[status]}</span>
            </li>
          );
        })}
      </ol>
      <p className="muted small">Objectives are satisfied by observed technical evidence, not by clicks.</p>
    </section>
  );
}
