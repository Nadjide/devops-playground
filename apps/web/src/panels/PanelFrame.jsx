import { sourceLabel } from '../components/format.js';

export function PanelFrame({ id, title, source = null, actions = null, children }) {
  return (
    <section className="panel" aria-labelledby={`${id}-heading`}>
      <header className="panel-header">
        <h2 id={`${id}-heading`} className="panel-title">{title}</h2>
        {source ? <span className="source-tag" title="Observation source">{sourceLabel(source)}</span> : null}
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}
