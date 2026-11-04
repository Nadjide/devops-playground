import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Power, RotateCcw } from 'lucide-react';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';

export function SessionMenu() {
  const client = useSessionClient();
  const state = useSessionState();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const items = [
    { id: 'reset', label: 'Reset session', icon: RotateCcw, type: 'session.reset' },
    { id: 'end', label: 'End session', icon: Power, type: 'session.end' },
  ];

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    function onPointerDown(event) {
      if (!menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onMenuKeyDown(event) {
    const entries = [...menuRef.current.querySelectorAll('[role="menuitem"]')];
    const index = entries.indexOf(document.activeElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      entries[next].focus();
    }
  }

  return (
    <div className="menu-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="button button-quiet"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={state.status !== 'ready'}
        onClick={() => setOpen((value) => !value)}
      >
        Session <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" aria-label="Session actions" className="menu" onKeyDown={onMenuKeyDown}>
          {items.map((item) => {
            const available = client.isAvailable(item.type);
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                aria-disabled={!available || undefined}
                onClick={() => {
                  if (available) {
                    close();
                  }
                }}
              >
                <Icon aria-hidden="true" size={15} />
                <span>{item.label}</span>
                {!available ? <span className="menu-note">Unavailable</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
