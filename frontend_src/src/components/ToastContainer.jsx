import { useState, useEffect } from 'react';
import { setToastFn } from './shared';

export default function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    setToastFn((msg, type = 'green') => {
      const id = Date.now();
      setToasts(t => [...t, { id, msg, type }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
    });
  }, []);

  if (!toasts.length) return null;

  const icons = {
    green:  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>,
    red:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
    yellow: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  };

  return (
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
      {toasts.map(t => (
        <div
          key={t.id}
          style={{
            background: t.type === 'green' ? 'var(--green)' : t.type === 'red' ? 'var(--red)' : 'var(--yellow)',
            color: '#fff',
            padding: '10px 16px',
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 500,
            boxShadow: 'var(--shadow-lg)',
            animation: 'slideIn .2s cubic-bezier(.34,1.2,.64,1)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            maxWidth: 360,
            minWidth: 220,
          }}
        >
          {icons[t.type] || icons.green}
          {t.msg}
        </div>
      ))}
    </div>
  );
}
