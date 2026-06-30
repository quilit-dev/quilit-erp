import { useState, useEffect, useCallback } from 'react';
import { getCategories, createCategory, updateCategory, archiveCategory, getAccounts } from '../api/client';
import { invalidateCategories } from '../hooks/useCategories';
import { Modal, ConfirmModal, toast } from './shared';
import { useLocale } from '../hooks/useLocale.jsx';

// Owner-managed category registry. Per-domain lists that feed every category
// dropdown across the app. Editing here never rewrites existing records — it
// only changes what the pickers offer.

const DOMAINS = [
  { key: 'inventory', labelKey: 'settings.catDomainInventory' },
  { key: 'expense',   labelKey: 'settings.catDomainExpense' },
  { key: 'asset',     labelKey: 'settings.catDomainAsset' },
  { key: 'project',   labelKey: 'settings.catDomainProject' },
];

export default function CategoriesManager({ canEdit }) {
  const { t, tCategory } = useLocale();
  const [domain, setDomain] = useState('inventory');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState('');
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');
  const [removeTarget, setRemoveTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const isExpense = domain === 'expense';

  const load = useCallback(() => {
    setLoading(true);
    getCategories(domain)
      .then(r => setRows(Array.isArray(r) ? r : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [domain]);
  useEffect(() => { load(); }, [load]);

  // Expense categories can be pinned to a specific ledger account; load the
  // Expense accounts for the picker only when that domain is selected.
  useEffect(() => {
    if (!isExpense) { setAccounts([]); return; }
    getAccounts({ type: 'Expense', active: true })
      .then(r => setAccounts(Array.isArray(r) ? r : []))
      .catch(() => setAccounts([]));
  }, [isExpense]);

  async function setGl(r, code) {
    setBusy(true);
    try {
      await updateCategory(r.id, { name: r.name, account_code: code });
      invalidateCategories(); load();
      toast(t('settings.catGlUpdated'));
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function add(e) {
    e.preventDefault();
    const name = adding.trim();
    if (!name) return;
    setBusy(true);
    try {
      await createCategory({ domain, name });
      setAdding(''); invalidateCategories(); load();
      toast(t('settings.catAdded'));
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function saveEdit() {
    const name = editName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await updateCategory(editId, { name });
      setEditId(null); invalidateCategories(); load();
      toast(t('settings.catUpdated'));
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function remove() {
    try {
      await archiveCategory(removeTarget.id);
      setRemoveTarget(null); invalidateCategories(); load();
      toast(t('settings.catRemoved'));
    } catch (err) { toast(err.message, 'red'); }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
        {t('settings.categoriesDesc')}
      </p>

      {/* Domain selector */}
      <div className="tabs" style={{ marginBottom: 14 }}>
        {DOMAINS.map(d => (
          <button key={d.key} type="button"
            className={`tab-btn${domain === d.key ? ' active' : ''}`}
            onClick={() => setDomain(d.key)}>
            {t(d.labelKey)}
          </button>
        ))}
      </div>

      {canEdit && (
        <form onSubmit={add} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input className="form-control" style={{ maxWidth: 280 }}
            placeholder={t('settings.catAddPlaceholder')}
            value={adding} onChange={e => setAdding(e.target.value)} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !adding.trim()}>
            {t('settings.addCategory')}
          </button>
        </form>
      )}

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-3)', fontSize: 13,
          border: '1px dashed var(--border)', borderRadius: 6 }}>
          {t('settings.catNoneYet')}
        </div>
      ) : isExpense ? (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 8px' }}>
            {t('settings.catGlHint')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', borderRadius: 8, background: 'var(--bg)' }}>
                <span style={{ flex: 1, fontSize: 13 }}>{tCategory(r.name)}</span>
                {canEdit ? (
                  <select className="form-control" style={{ maxWidth: 260, fontSize: 12, padding: '4px 8px' }}
                    value={r.account_code || ''} disabled={busy}
                    onChange={e => setGl(r, e.target.value)}>
                    <option value="">{t('settings.catGlDefault')}</option>
                    {accounts.map(a => (
                      <option key={a.code} value={a.code}>{a.code} — {a.name}</option>
                    ))}
                  </select>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {r.account_code
                      ? (() => { const a = accounts.find(x => x.code === r.account_code);
                                 return a ? `${a.code} — ${a.name}` : r.account_code; })()
                      : t('settings.catGlDefault')}
                  </span>
                )}
                {canEdit && (
                  <>
                    <button type="button" title={t('common.edit')}
                      onClick={() => { setEditId(r.id); setEditName(r.name); }}
                      style={{ border: 'none', background: 'transparent', color: 'var(--text-3)', cursor: 'pointer', padding: 2 }}>
                      ✎
                    </button>
                    <button type="button" title={t('common.remove')}
                      onClick={() => setRemoveTarget(r)}
                      style={{ border: 'none', background: 'var(--border)', color: 'var(--text-2)',
                        width: 18, height: 18, borderRadius: '50%', cursor: 'pointer', lineHeight: 1 }}>
                      ×
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {rows.map(r => (
            <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '5px 6px 5px 12px', borderRadius: 18, background: 'var(--bg)', fontSize: 13 }}>
              {tCategory(r.name)}
              {canEdit && (
                <>
                  <button type="button" title={t('common.edit')}
                    onClick={() => { setEditId(r.id); setEditName(r.name); }}
                    style={{ border: 'none', background: 'transparent', color: 'var(--text-3)', cursor: 'pointer', padding: 2 }}>
                    ✎
                  </button>
                  <button type="button" title={t('common.remove')}
                    onClick={() => setRemoveTarget(r)}
                    style={{ border: 'none', background: 'var(--border)', color: 'var(--text-2)',
                      width: 18, height: 18, borderRadius: '50%', cursor: 'pointer', lineHeight: 1 }}>
                    ×
                  </button>
                </>
              )}
            </span>
          ))}
        </div>
      )}

      {editId != null && (
        <Modal title={t('settings.catEditTitle')} onClose={() => setEditId(null)}>
          <div className="modal-body">
            <label className="form-label">{t('settings.catName')}</label>
            <input className="form-control" value={editName} autoFocus
              onChange={e => setEditName(e.target.value)} />
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setEditId(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" disabled={busy || !editName.trim()} onClick={saveEdit}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </Modal>
      )}

      {removeTarget && (
        <ConfirmModal
          title={t('settings.catRemoveTitle')}
          message={t('settings.catRemoveConfirm', { name: removeTarget.name })}
          confirmLabel={t('common.remove')}
          confirmClass="btn-danger"
          onConfirm={remove}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
