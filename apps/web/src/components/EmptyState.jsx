export function EmptyState({ icon: Icon, title, children }) {
  return (
    <div className="empty-state">
      {Icon ? <Icon aria-hidden="true" size={22} /> : null}
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-body">{children}</p> : null}
    </div>
  );
}
