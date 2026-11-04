import { useRef } from 'react';

/**
 * WAI-ARIA tabs with roving focus. Arrow keys, Home, and End move between tabs
 * and activate them, so keyboard users can switch every panel.
 */
export function Tabs({ id, label, items, selectedId, onSelect, className = '' }) {
  const tabRefs = useRef(new Map());

  function focusTab(index) {
    const item = items[(index + items.length) % items.length];
    onSelect(item.id);
    tabRefs.current.get(item.id)?.focus();
  }

  function onKeyDown(event) {
    const index = items.findIndex((item) => item.id === selectedId);
    const moves = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
    if (event.key in moves) {
      event.preventDefault();
      focusTab(moves[event.key]);
    }
  }

  return (
    <div role="tablist" aria-label={label} className={`tablist ${className}`} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const selected = item.id === selectedId;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) {
                tabRefs.current.set(item.id, node);
              } else {
                tabRefs.current.delete(item.id);
              }
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`${id}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            className="tab"
            onClick={() => onSelect(item.id)}
          >
            {Icon ? <Icon aria-hidden="true" size={15} /> : null}
            <span>{item.title}</span>
            {item.badge ? <span className="tab-badge">{item.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, itemId, children, className = '' }) {
  return (
    <div
      role="tabpanel"
      id={`${id}-panel-${itemId}`}
      aria-labelledby={`${id}-tab-${itemId}`}
      tabIndex={0}
      className={`tabpanel ${className}`}
    >
      {children}
    </div>
  );
}
