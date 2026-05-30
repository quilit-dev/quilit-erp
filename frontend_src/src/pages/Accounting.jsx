import { useState, useEffect, useCallback } from 'react';
import {
  getAccounts, createAccount, updateAccount, deleteAccount,
  getJournalEntries, getJournalEntry, createJournalEntry, reverseJournalEntry,
  getGeneralLedger, getTrialBalance, getBalanceSheet, getIncomeStatement,
  getAccountingSummary,
} from '../api/client';
import {
  LoadingSpinner, Modal, ConfirmModal, toast, ExportButton,
} from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';

const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthStartISO = () => todayISO().slice(0, 7) + '-01';

export default function Accounting() {
  const { t, fmt, fmtDate } = useLocale();
  const { can } = usePermissions();
  const canEdit = can('accounting', 'edit');
  const canCreate = can('accounting', 'create');
  const [tab, setTab] = useState('overview');

  const TABS = [
    ['overview', t('accounting.overview')],
    ['accounts', t('accounting.accounts')],
    ['journal', t('accounting.journal')],
    ['ledger', t('accounting.ledger')],
    ['trialBalance', t('accounting.trialBalance')],
    ['incomeStatement', t('accounting.incomeStatement')],
    ['balanceSheet', t('accounting.balanceSheet')],
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('accounting.title')}</h1>
          <p className="page-subtitle">{t('accounting.subtitle')}</p>
        </div>
      </div>

      <div className="tabs" style={{ flexWrap: 'wrap' }}>
        {TABS.map(([key, label]) => (
          <button key={key} className={`tab-btn${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview t={t} fmt={fmt} />}
      {tab === 'accounts' && <Accounts t={t} canCreate={canCreate} canEdit={canEdit} can={can} />}
      {tab === 'journal' && <Journal t={t} fmt={fmt} fmtDate={fmtDate} canCreate={canCreate} canEdit={canEdit} />}
      {tab === 'ledger' && <Ledger t={t} fmt={fmt} fmtDate={fmtDate} />}
      {tab === 'trialBalance' && <TrialBalance t={t} fmt={fmt} />}
      {tab === 'incomeStatement' && <IncomeStatement t={t} fmt={fmt} />}
      {tab === 'balanceSheet' && <BalanceSheet t={t} fmt={fmt} />}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────
function Overview({ t, fmt }) {
  const [s, setS] = useState(null);
  useEffect(() => { getAccountingSummary().then(setS).catch(e => toast(e.message, 'red')); }, []);
  if (!s) return <LoadingSpinner />;
  const cards = [
    [t('accounting.totalIncome'), fmt(s.month_income), 'green'],
    [t('accounting.totalExpense'), fmt(s.month_expense), 'red'],
    [t('accounting.netIncome'), fmt(s.month_net), s.month_net >= 0 ? 'green' : 'red'],
    [t('accounting.totalAssets'), fmt(s.total_assets), 'blue'],
  ];
  return (
    <>
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        {cards.map(([label, value, color]) => (
          <div className="stat-card" key={label}>
            <div className="stat-label">{label}</div>
            <div className="stat-value" style={{ color: `var(--${color})` }}>{value}</div>
          </div>
        ))}
      </div>
      <div className="card"><div className="card-body" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
        <span>{t('accounting.accounts')}: <strong>{s.accounts}</strong></span>
        <span>{t('accounting.posted')}: <strong>{s.posted_entries}</strong></span>
        <span>{t('accounting.balanceSheet')}:{' '}
          <strong style={{ color: s.balanced ? 'var(--green)' : 'var(--red)' }}>
            {s.balanced ? `✓ ${t('accounting.balanced')}` : `⚠ ${t('accounting.notBalanced')}`}
          </strong>
        </span>
      </div></div>
      <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 12 }}>
        {t('accounting.subtitle')} · {t('accounting.overview')} — {monthStartISO()} → {todayISO()}
      </p>
    </>
  );
}

// ── Chart of Accounts ────────────────────────────────────────────────────
function Accounts({ t, canCreate, canEdit, can }) {
  const [rows, setRows] = useState(null);
  const [modal, setModal] = useState(null);   // {id?, code, name, type, subtype, description}
  const [confirmDel, setConfirmDel] = useState(null);
  const load = useCallback(() => getAccounts().then(setRows).catch(e => toast(e.message, 'red')), []);
  useEffect(() => { load(); }, [load]);
  if (!rows) return <LoadingSpinner />;

  async function save() {
    try {
      if (modal.id) await updateAccount(modal.id, { name: modal.name, subtype: modal.subtype, description: modal.description, is_active: modal.is_active });
      else await createAccount({ code: modal.code, name: modal.name, type: modal.type, subtype: modal.subtype, description: modal.description });
      toast(`${modal.code || ''} ${modal.name}`.trim()); setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
  }
  async function toggle(a) {
    try { await updateAccount(a.id, { is_active: !a.is_active }); load(); }
    catch (e) { toast(e.message, 'red'); }
  }
  async function doDelete(a) {
    setConfirmDel(null);
    try { await deleteAccount(a.id); toast('Deleted'); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="card-title">{t('accounting.accounts')}</span>
        {canCreate && <button className="btn btn-sm btn-primary" onClick={() => setModal({ code: '', name: '', type: 'Expense', subtype: '', description: '' })}>＋ {t('accounting.newAccount')}</button>}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>{t('accounting.code')}</th><th>{t('accounting.name')}</th>
            <th>{t('accounting.type')}</th><th>{t('accounting.subtype')}</th>
            <th></th><th></th>
          </tr></thead>
          <tbody>
            {rows.map(a => (
              <tr key={a.id} style={{ opacity: a.is_active ? 1 : 0.5 }}>
                <td className="text-mono">{a.code}</td>
                <td className="td-primary">{a.name}{a.is_system ? <span className="badge badge-gray" style={{ marginInlineStart: 6 }}>{t('accounting.systemAccount')}</span> : null}</td>
                <td>{a.type}</td>
                <td style={{ color: 'var(--text-3)' }}>{a.subtype || '—'}{a.is_active ? '' : ` · ${t('accounting.inactive')}`}</td>
                <td style={{ textAlign: 'right' }}>
                  {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => setModal({ ...a })}>{t('common.edit')}</button>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {canEdit && !a.is_system && (
                    <button className="btn btn-sm btn-secondary" onClick={() => toggle(a)}>
                      {a.is_active ? t('accounting.deactivate') : t('accounting.activate')}
                    </button>
                  )}
                  {can('accounting', 'delete') && !a.is_system && (
                    <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }} onClick={() => setConfirmDel(a)}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal title={modal.id ? t('common.edit') : t('accounting.newAccount')} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">{t('accounting.code')}</label>
                <input className="form-control" value={modal.code} disabled={!!modal.id}
                  onChange={e => setModal(m => ({ ...m, code: e.target.value }))} placeholder="6950" />
              </div>
              <div className="form-group">
                <label className="form-label">{t('accounting.type')}</label>
                <select className="form-control" value={modal.type} disabled={!!modal.id}
                  onChange={e => setModal(m => ({ ...m, type: e.target.value }))}>
                  {ACCOUNT_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div className="form-group form-full">
                <label className="form-label">{t('accounting.name')}</label>
                <input className="form-control" value={modal.name}
                  onChange={e => setModal(m => ({ ...m, name: e.target.value }))} />
              </div>
              <div className="form-group form-full">
                <label className="form-label">{t('accounting.subtype')}</label>
                <input className="form-control" value={modal.subtype || ''}
                  onChange={e => setModal(m => ({ ...m, subtype: e.target.value }))} placeholder="Operating Expense" />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={save} disabled={!modal.name || (!modal.id && !modal.code)}>{t('common.save')}</button>
          </div>
        </Modal>
      )}
      {confirmDel && (
        <ConfirmModal title={t('common.delete')} confirmClass="btn-danger" confirmLabel={t('common.delete')}
          message={`${confirmDel.code} — ${confirmDel.name}`}
          onConfirm={() => doDelete(confirmDel)} onCancel={() => setConfirmDel(null)} />
      )}
    </div>
  );
}

// ── Journal ────────────────────────────────────────────────────────────────
function Journal({ t, fmt, fmtDate, canCreate, canEdit }) {
  const [start, setStart] = useState(monthStartISO());
  const [end, setEnd] = useState(todayISO());
  const [rows, setRows] = useState(null);
  const [detail, setDetail] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirmRev, setConfirmRev] = useState(null);

  const load = useCallback(() => {
    getJournalEntries({ start, end }).then(setRows).catch(e => toast(e.message, 'red'));
  }, [start, end]);
  useEffect(() => { load(); }, [load]);

  async function openDetail(id) {
    try { setDetail(await getJournalEntry(id)); } catch (e) { toast(e.message, 'red'); }
  }
  async function doReverse(id) {
    setConfirmRev(null);
    try { await reverseJournalEntry(id); toast(t('accounting.reversed')); setDetail(null); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span className="card-title">{t('accounting.journal')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" className="form-control" style={{ width: 150 }} value={start} onChange={e => setStart(e.target.value)} />
          <input type="date" className="form-control" style={{ width: 150 }} value={end} onChange={e => setEnd(e.target.value)} />
          {canCreate && <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>＋ {t('accounting.newEntry')}</button>}
        </div>
      </div>
      {!rows ? <LoadingSpinner /> : rows.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('accounting.noEntries')}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>#</th><th>{t('common.date')}</th><th>{t('accounting.memo')}</th>
              <th>{t('accounting.source')}</th><th style={{ textAlign: 'right' }}>{t('accounting.debit')}</th>
              <th>{t('common.status')}</th>
            </tr></thead>
            <tbody>
              {rows.map(e => (
                <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(e.id)}>
                  <td className="text-mono">{e.entry_number}</td>
                  <td>{fmtDate(e.entry_date)}</td>
                  <td className="td-primary">{e.memo}</td>
                  <td><span className="badge badge-gray">{e.source_type || 'manual'}</span></td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(e.total_debit)}</td>
                  <td>
                    <span className={`badge badge-${e.status === 'posted' ? 'green' : e.status === 'reversed' ? 'red' : 'gray'}`}>
                      {e.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <EntryDetail entry={detail} t={t} fmt={fmt} fmtDate={fmtDate} canEdit={canEdit}
          onClose={() => setDetail(null)} onReverse={() => setConfirmRev(detail.id)} />
      )}
      {adding && (
        <NewEntryModal t={t} fmt={fmt} onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); }} />
      )}
      {confirmRev != null && (
        <ConfirmModal title={t('accounting.reverse')} message={t('accounting.confirmReverse')}
          confirmLabel={t('accounting.reverse')} confirmClass="btn-danger"
          onConfirm={() => doReverse(confirmRev)} onCancel={() => setConfirmRev(null)} />
      )}
    </div>
  );
}

function EntryDetail({ entry, t, fmt, fmtDate, canEdit, onClose, onReverse }) {
  const reversible = entry.status === 'posted' && !entry.reversed_by;
  return (
    <Modal title={`${entry.entry_number} · ${fmtDate(entry.entry_date)}`} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 0 }}>{entry.memo}</p>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('accounting.account')}</th><th>{t('accounting.memo')}</th>
              <th style={{ textAlign: 'right' }}>{t('accounting.debit')}</th>
              <th style={{ textAlign: 'right' }}>{t('accounting.credit')}</th>
            </tr></thead>
            <tbody>
              {entry.lines.map(l => (
                <tr key={l.id}>
                  <td><span className="text-mono">{l.account_code}</span> {l.account_name}</td>
                  <td style={{ color: 'var(--text-3)' }}>{l.memo || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{l.debit ? fmt(l.debit) : ''}</td>
                  <td style={{ textAlign: 'right' }}>{l.credit ? fmt(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
              <td colSpan={2} style={{ textAlign: 'right' }}>Σ</td>
              <td style={{ textAlign: 'right' }}>{fmt(entry.total_debit)}</td>
              <td style={{ textAlign: 'right' }}>{fmt(entry.total_credit)}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>
      <div className="modal-footer">
        {canEdit && reversible && <button className="btn btn-danger" onClick={onReverse}>{t('accounting.reverse')}</button>}
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  );
}

function NewEntryModal({ t, fmt, onClose, onSaved }) {
  const [accounts, setAccounts] = useState([]);
  const [date, setDate] = useState(todayISO());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }]);
  const [saving, setSaving] = useState(false);
  useEffect(() => { getAccounts({ active: true }).then(setAccounts).catch(() => {}); }, []);

  const totalD = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const totalC = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const balanced = Math.abs(totalD - totalC) < 0.005 && totalD > 0;

  function setLine(i, patch) { setLines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l)); }

  async function save() {
    setSaving(true);
    try {
      await createJournalEntry({
        entry_date: date, memo,
        lines: lines
          .filter(l => l.account_id && ((parseFloat(l.debit) || 0) > 0 || (parseFloat(l.credit) || 0) > 0))
          .map(l => ({ account_id: Number(l.account_id), debit: parseFloat(l.debit) || 0, credit: parseFloat(l.credit) || 0 })),
      });
      toast(t('accounting.posted')); onSaved();
    } catch (e) { toast(e.message, 'red'); } finally { setSaving(false); }
  }

  return (
    <Modal title={t('accounting.newEntry')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <div className="form-grid" style={{ marginBottom: 12 }}>
          <div className="form-group">
            <label className="form-label">{t('accounting.entryDate')}</label>
            <input type="date" className="form-control" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('accounting.memo')}</label>
            <input className="form-control" value={memo} onChange={e => setMemo(e.target.value)} />
          </div>
        </div>
        <table style={{ width: '100%' }}>
          <thead><tr style={{ fontSize: 12, color: 'var(--text-3)' }}>
            <th style={{ textAlign: 'left' }}>{t('accounting.account')}</th>
            <th style={{ width: 120, textAlign: 'right' }}>{t('accounting.debit')}</th>
            <th style={{ width: 120, textAlign: 'right' }}>{t('accounting.credit')}</th>
            <th style={{ width: 30 }}></th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="form-control" value={l.account_id} onChange={e => setLine(i, { account_id: e.target.value })}>
                    <option value="">{t('accounting.selectAccount')}</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                  </select>
                </td>
                <td><input type="number" min="0" step="0.01" className="form-control" style={{ textAlign: 'right' }}
                  value={l.debit} onChange={e => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                <td><input type="number" min="0" step="0.01" className="form-control" style={{ textAlign: 'right' }}
                  value={l.credit} onChange={e => setLine(i, { credit: e.target.value, debit: '' })} /></td>
                <td>{lines.length > 2 && <button className="btn btn-sm btn-secondary" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn btn-sm btn-secondary" style={{ marginTop: 8 }}
          onClick={() => setLines(ls => [...ls, { account_id: '', debit: '', credit: '' }])}>＋ {t('accounting.addLine')}</button>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 12, fontWeight: 600 }}>
          <span>{t('accounting.totalDebit')}: {fmt(totalD)}</span>
          <span>{t('accounting.totalCredit')}: {fmt(totalC)}</span>
          <span style={{ color: balanced ? 'var(--green)' : 'var(--red)' }}>
            {balanced ? `✓ ${t('accounting.balanced')}` : t('accounting.notBalanced')}
          </span>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" onClick={save} disabled={!balanced || saving}
          title={!balanced ? t('accounting.mustBalance') : ''}>{saving ? t('common.saving') : t('accounting.posted')}</button>
      </div>
    </Modal>
  );
}

// ── General Ledger ───────────────────────────────────────────────────────
function Ledger({ t, fmt, fmtDate }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [start, setStart] = useState(monthStartISO());
  const [end, setEnd] = useState(todayISO());
  const [data, setData] = useState(null);
  useEffect(() => { getAccounts({ active: true }).then(setAccounts).catch(() => {}); }, []);
  useEffect(() => {
    if (!accountId) { setData(null); return; }
    getGeneralLedger({ account_id: accountId, start, end }).then(setData).catch(e => toast(e.message, 'red'));
  }, [accountId, start, end]);

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="form-control" style={{ maxWidth: 280 }} value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">{t('accounting.selectAccount')}</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
        </select>
        <input type="date" className="form-control" style={{ width: 150 }} value={start} onChange={e => setStart(e.target.value)} />
        <input type="date" className="form-control" style={{ width: 150 }} value={end} onChange={e => setEnd(e.target.value)} />
      </div>
      {!accountId ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('accounting.selectAccount')}</div>
      ) : !data ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('common.date')}</th><th>{t('accounting.memo')}</th>
              <th style={{ textAlign: 'right' }}>{t('accounting.debit')}</th>
              <th style={{ textAlign: 'right' }}>{t('accounting.credit')}</th>
              <th style={{ textAlign: 'right' }}>{t('accounting.balance')}</th>
            </tr></thead>
            <tbody>
              <tr style={{ color: 'var(--text-3)' }}>
                <td colSpan={4}>{t('accounting.openingBalance')}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(data.opening_balance)}</td>
              </tr>
              {data.transactions.map((x, i) => (
                <tr key={i}>
                  <td>{fmtDate(x.date)}</td>
                  <td>{x.memo}</td>
                  <td style={{ textAlign: 'right' }}>{x.debit ? fmt(x.debit) : ''}</td>
                  <td style={{ textAlign: 'right' }}>{x.credit ? fmt(x.credit) : ''}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(x.balance)}</td>
                </tr>
              ))}
              {data.transactions.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>{t('accounting.noTransactions')}</td></tr>
              )}
            </tbody>
            <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
              <td colSpan={4}>{t('accounting.closingBalance')}</td>
              <td style={{ textAlign: 'right' }}>{fmt(data.closing_balance)}</td>
            </tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Trial Balance ────────────────────────────────────────────────────────
function TrialBalance({ t, fmt }) {
  const [asOf, setAsOf] = useState(todayISO());
  const [data, setData] = useState(null);
  useEffect(() => { getTrialBalance({ as_of: asOf }).then(setData).catch(e => toast(e.message, 'red')); }, [asOf]);
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="card-title">{t('accounting.trialBalance')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('accounting.asOf')}</span>
          <input type="date" className="form-control" style={{ width: 150 }} value={asOf} onChange={e => setAsOf(e.target.value)} />
          {data && <ExportButton data={data.rows} filename={`trial-balance-${asOf}`} sheetName="TrialBalance" />}
        </div>
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('accounting.code')}</th><th>{t('accounting.name')}</th><th>{t('accounting.type')}</th>
              <th style={{ textAlign: 'right' }}>{t('accounting.debit')}</th>
              <th style={{ textAlign: 'right' }}>{t('accounting.credit')}</th>
            </tr></thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.code}>
                  <td className="text-mono">{r.code}</td><td>{r.name}</td><td style={{ color: 'var(--text-3)' }}>{r.type}</td>
                  <td style={{ textAlign: 'right' }}>{r.debit ? fmt(r.debit) : ''}</td>
                  <td style={{ textAlign: 'right' }}>{r.credit ? fmt(r.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
              <td colSpan={3} style={{ textAlign: 'right' }}>
                {data.balanced ? `✓ ${t('accounting.balanced')}` : `⚠ ${t('accounting.notBalanced')}`}
              </td>
              <td style={{ textAlign: 'right' }}>{fmt(data.total_debit)}</td>
              <td style={{ textAlign: 'right' }}>{fmt(data.total_credit)}</td>
            </tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Income Statement ─────────────────────────────────────────────────────
function StatementSection({ title, rows, fmt, color }) {
  return (
    <>
      <tr style={{ background: 'var(--surface-2, #f9fafb)' }}>
        <td colSpan={2} style={{ fontWeight: 700, color: color ? `var(--${color})` : undefined }}>{title}</td>
      </tr>
      {rows.map(r => (
        <tr key={r.code}>
          <td style={{ paddingInlineStart: 24 }}><span className="text-mono" style={{ color: 'var(--text-3)' }}>{r.code}</span> {r.name}</td>
          <td style={{ textAlign: 'right' }}>{fmt(r.balance)}</td>
        </tr>
      ))}
      {rows.length === 0 && <tr><td style={{ paddingInlineStart: 24, color: 'var(--text-3)' }}>—</td><td style={{ textAlign: 'right' }}>{fmt(0)}</td></tr>}
    </>
  );
}

function IncomeStatement({ t, fmt }) {
  const [start, setStart] = useState(monthStartISO());
  const [end, setEnd] = useState(todayISO());
  const [data, setData] = useState(null);
  useEffect(() => { getIncomeStatement({ start, end }).then(setData).catch(e => toast(e.message, 'red')); }, [start, end]);
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="card-title">{t('accounting.incomeStatement')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="date" className="form-control" style={{ width: 150 }} value={start} onChange={e => setStart(e.target.value)} />
          <input type="date" className="form-control" style={{ width: 150 }} value={end} onChange={e => setEnd(e.target.value)} />
        </div>
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap"><table>
          <tbody>
            <StatementSection title={t('accounting.income')} rows={data.income} fmt={fmt} color="green" />
            <tr style={{ fontWeight: 600 }}><td style={{ textAlign: 'right' }}>{t('accounting.totalIncome')}</td><td style={{ textAlign: 'right' }}>{fmt(data.total_income)}</td></tr>
            <StatementSection title={t('accounting.expense')} rows={data.expense} fmt={fmt} color="red" />
            <tr style={{ fontWeight: 600 }}><td style={{ textAlign: 'right' }}>{t('accounting.totalExpense')}</td><td style={{ textAlign: 'right' }}>{fmt(data.total_expense)}</td></tr>
            <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)', fontSize: 15 }}>
              <td style={{ textAlign: 'right' }}>{t('accounting.netIncome')}</td>
              <td style={{ textAlign: 'right', color: data.net_income >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(data.net_income)}</td>
            </tr>
          </tbody>
        </table></div>
      )}
    </div>
  );
}

// ── Balance Sheet ────────────────────────────────────────────────────────
function BalanceSheet({ t, fmt }) {
  const [asOf, setAsOf] = useState(todayISO());
  const [data, setData] = useState(null);
  useEffect(() => { getBalanceSheet({ as_of: asOf }).then(setData).catch(e => toast(e.message, 'red')); }, [asOf]);
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="card-title">{t('accounting.balanceSheet')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('accounting.asOf')}</span>
          <input type="date" className="form-control" style={{ width: 150 }} value={asOf} onChange={e => setAsOf(e.target.value)} />
        </div>
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap"><table>
          <tbody>
            <StatementSection title={t('accounting.assets')} rows={data.assets} fmt={fmt} color="blue" />
            <tr style={{ fontWeight: 700 }}><td style={{ textAlign: 'right' }}>{t('accounting.totalAssets')}</td><td style={{ textAlign: 'right' }}>{fmt(data.total_assets)}</td></tr>
            <StatementSection title={t('accounting.liabilities')} rows={data.liabilities} fmt={fmt} />
            <StatementSection title={t('accounting.equity')} rows={data.equity} fmt={fmt} />
            <tr><td style={{ paddingInlineStart: 24 }}>{t('accounting.currentEarnings')}</td><td style={{ textAlign: 'right' }}>{fmt(data.net_income)}</td></tr>
            <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
              <td style={{ textAlign: 'right' }}>{t('accounting.liabilitiesAndEquity')}</td>
              <td style={{ textAlign: 'right' }}>{fmt(data.total_liabilities_equity)}</td>
            </tr>
            <tr><td colSpan={2} style={{ textAlign: 'right', color: data.balanced ? 'var(--green)' : 'var(--red)', fontSize: 12 }}>
              {data.balanced ? `✓ ${t('accounting.balanced')}` : `⚠ ${t('accounting.notBalanced')}`}
            </td></tr>
          </tbody>
        </table></div>
      )}
    </div>
  );
}
