import { useState, useEffect } from 'react';

/**
 * ServerGate — waits for the backend to be fully ready before rendering children.
 *
 * Problem: The OS-level TCP port becomes available ~100-200ms before uvicorn
 * has finished registering all routes. The launcher opens the browser as soon
 * as the port is reachable, so the first wave of API requests hits the server
 * during this window and gets HTTP 500. Pressing "Retry" always works because
 * by then the server is ready.
 *
 * Fix: Poll /api/health (the LAST registered route, so 200 = fully ready)
 * before rendering any page components. Once ready, children render normally.
 * The poll interval is short so users never notice the wait in practice.
 */
export default function ServerGate({ children }) {
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function poll() {
      try {
        const res = await fetch('/api/health', { method: 'GET' });
        if (res.ok && !cancelled) {
          setReady(true);
          return;
        }
      } catch {
        // server not yet ready — keep polling
      }
      if (!cancelled) {
        setAttempt(a => a + 1);
        timer = setTimeout(poll, 250);   // retry every 250 ms
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!ready) {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg, #f5f6fa)',
        gap: 16,
      }}>
        <div style={{
          width: 48, height: 48, border: '3px solid var(--border, #e2e8f0)',
          borderTopColor: 'var(--accent, #2563eb)',
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <p style={{ color: 'var(--text-3, #64748b)', fontSize: 14, margin: 0 }}>
          {attempt < 4 ? 'Starting up…' : 'Waiting for server…'}
        </p>
      </div>
    );
  }

  return children;
}
