import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { LoadingSpinner, ErrorAlert, EmptyState } from '../components/shared';
import { getPosSession, getCommitmentCount } from '../api/client';

// Register/checkout/receipt/history extracted into ./pos/ — this file is the
// orchestrator (session state + tab switch). Pricing helpers live in pos/pricing.js.
import { OpenRegisterPanel } from './pos/OpenRegisterPanel';
import { ReceiptModal } from './pos/ReceiptModal';
import { RegisterView } from './pos/RegisterView';
import { SessionsView } from './pos/SessionsView';
import { HistoryView } from './pos/HistoryView';
import { WaitingView } from './pos/WaitingView';

export default function POS() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [view, setView] = useState('register');
  const [session, setSession] = useState(undefined);   // undefined = loading, null = none
  const [error, setError] = useState(null);
  const [receipt, setReceipt] = useState(null);

  const canCreate = can('pos', 'create');
  const canReturn = can('pos', 'edit');

  const loadSession = useCallback(() => {
    setError(null);
    getPosSession()
      .then(s => setSession(s || null))
      .catch(e => { setError(e.message); setSession(null); });
  }, []);
  useEffect(() => { loadSession(); }, [loadSession]);

  // How many customers are waiting on goods, and how many of those could be
  // rung today. The second number is the one worth a badge: it is the only
  // one that asks somebody to do something.
  const [waiting, setWaiting] = useState({ open: 0, ready: 0 });
  useEffect(() => {
    getCommitmentCount().then(setWaiting).catch(() => {});
  }, [view]);

  const tabs = [
    { key: 'register', label: t('pos.register') },
    { key: 'sessions', label: t('pos.sessions') },
    { key: 'history',  label: t('pos.history') },
    { key: 'waiting',  label: t('pos.waiting'), badge: waiting.ready },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>{t('pos.title')}</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {tabs.map(tb => (
            <button key={tb.key}
              className={`btn btn-sm ${view === tb.key ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView(tb.key)}>
              {tb.label}
              {tb.badge > 0 && (
                <span className="badge badge-green"
                      style={{ marginInlineStart: 6 }}>{tb.badge}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorAlert message={error} onRetry={loadSession} />}

      {receipt && <ReceiptModal sale={receipt} onClose={() => setReceipt(null)} />}

      {view === 'register' && (
        session === undefined ? <LoadingSpinner />
        : !canCreate ? <EmptyState message={t('pos.needOpenSession')} icon="🔒" />
        : session === null ? <OpenRegisterPanel onOpened={loadSession} />
        : <RegisterView
            session={session}
            onClose={loadSession}
            onSold={(res) => { setReceipt(res); loadSession(); }}
          />
      )}

      {view === 'sessions' && <SessionsView />}
      {view === 'history'  && <HistoryView canReturn={canReturn} />}
      {view === 'waiting'  && <WaitingView canEdit={canReturn} />}
    </div>
  );
}
