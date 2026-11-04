/**
 * Icon-only control with an accessible name and a visible tooltip.
 * Unavailable controls stay focusable and explain why they cannot run.
 */
export function IconButton({ icon: Icon, label, onClick, unavailableReason = null, busy = false, tone = 'default' }) {
  const unavailable = Boolean(unavailableReason) || busy;
  const tooltip = unavailableReason ? `${label} (${unavailableReason})` : label;
  return (
    <button
      type="button"
      className={`icon-button tone-${tone}`}
      aria-label={label}
      aria-disabled={unavailable || undefined}
      aria-busy={busy || undefined}
      data-tooltip={tooltip}
      onClick={(event) => {
        if (unavailable) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      <Icon aria-hidden="true" size={16} />
    </button>
  );
}
