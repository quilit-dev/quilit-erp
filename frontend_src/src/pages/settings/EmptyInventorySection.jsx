// Emptying a tenant's inventory: every item, variant and product group.
//
// Vendor superadmin only. It is shown as a plan first --- what would go and
// what is blocking --- and runs only after the tenant's own name is typed.
// The server refuses outright if any document refers to any item, so the
// worst a wrong click can do here is remove stock nothing else has used.
import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { toast, fmt } from '../../components/shared';
import { getInventoryWipePlan, wipeInventory } from '../../api/client';

export default function EmptyInventorySection() {
  const { t } = useLocale();
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  function load() {
    setError(null);
    getInventoryWipePlan().then(setPlan).catch(e => setError(e.message));
  }
  useEffect(() => { load(); }, []);

  async function run() {
    if (!plan || !plan.can_run) return;
    setBusy(true);
    try {
      const res = await wipeInventory({ confirm: typed });
      setDone(res.removed);
      setTyped('');
      toast(t('settings.wipeDone'));
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  if (error) return <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>;
  if (!plan) return null;

  const blockers = Object.entries(plan.blockers || {});
  const empty = plan.items === 0 && plan.archived_items === 0 && plan.products === 0;
  const matches = typed.trim().toLowerCase() === String(plan.confirmation_phrase || '').toLowerCase();

  return (
    <div style={{ border: '1px solid var(--red)', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontWeight: 700, color: 'var(--red)', marginBottom: 6 }}>{t('settings.wipeTitle')}</div>
      <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '0 0 10px', lineHeight: 1.5 }}>
        {t('settings.wipeDesc')}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 }}>
        <Stat label={t('settings.wipeItems')} value={plan.items} />
        <Stat label={t('settings.wipeArchived')} value={plan.archived_items} />
        <Stat label={t('settings.wipeProducts')} value={plan.products} />
        <Stat label={t('settings.wipeUnits')} value={plan.stock_units} />
        <Stat label={t('settings.wipeValue')} value={fmt(plan.stock_value)} />
      </div>

      {/* The trial documents that go with the items: the till sales that carry
          an item line, with everything one creates, and the quotations that do. */}
      {plan.documents && (plan.documents.sales > 0 || plan.documents.quotations > 0) && (
        <div style={{ background: 'var(--yellow-light)', border: '1px solid var(--caution-ink)', borderRadius: 6,
                      padding: '8px 10px', fontSize: 12.5, marginBottom: 10 }}>
          <strong>{t('settings.wipeDocsTitle')}</strong>
          <div style={{ marginTop: 4 }}>
            {t('settings.wipeDocsLine', {
              sales: plan.documents.sales, invoices: plan.documents.invoices,
              payments: plan.documents.payments, entries: plan.documents.journal_entries,
              quotations: plan.documents.quotations })}
          </div>
        </div>
      )}

      {blockers.length > 0 && (
        <div style={{ background: 'var(--yellow-light)', border: '1px solid var(--caution-ink)', borderRadius: 6,
                      padding: '8px 10px', fontSize: 12.5, marginBottom: 10 }}>
          <strong>{t('settings.wipeBlocked')}</strong>
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {blockers.map(([k, n]) => <li key={k}><code>{k}</code> — {n}</li>)}
          </ul>
        </div>
      )}

      {empty ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{t('settings.wipeNothing')}</div>
      ) : plan.can_run && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="form-control" style={{ maxWidth: 260 }} value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={t('settings.wipeTypeName', { name: plan.confirmation_phrase })} />
          <button type="button" className="btn btn-danger" disabled={busy || !matches} onClick={run}>
            {busy ? t('common.saving') : t('settings.wipeRun')}
          </button>
        </div>
      )}

      {done && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
          {t('settings.wipeRemoved')}: {Object.entries(done).map(([k, n]) => `${k} ${n}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background: 'var(--bg)', borderRadius: 6, padding: '6px 10px' }}>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
