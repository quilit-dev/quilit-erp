import { useState, useEffect, useCallback } from 'react';
import {
  getAccounts, getJournalEntries, getJournalEntry,
  createJournalEntry, reverseJournalEntry,
} from '../../api/client';
import { LoadingSpinner, Modal, ConfirmModal, toast, NumberInput } from '../../components/shared';
import { monthStartISO, todayISO } from './constants';
import { SortableTh, Pager } from './ui';

// ── Journal ──────────────────────────────────────────────────────────────────
//
// Server-paged (the backend now returns {rows, total, source_types}). Every
// filter change resets the cursor to page 1 so the operator isn't stranded
// past the end of a freshly-filtered result set.
function Journal({ t, fmt, fmtDate, canCreate, canEdit }) {
  const [start, setStart]               = useState(monthStartISO());
  const [end,   setEnd]                 = useState(todayISO());
  const [sourceType, setSourceType]     = useState('');
  const [status,     setStatus]         = useState('');
  const [search,     setSearch]         = useState('');
  const [sort, setSort] = useState('entry_date');
  const [dir,  setDir]  = useState('desc');
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [detail,   setDetail]   = useState(null);
  const [adding,   setAdding]   = useState(false);
  const [confirmRev, setConfirmRev] = useState(null);

  // Reset to page 1 when any filter/sort/page-size changes — otherwise the
  // operator could be looking at page 3 of a 1-page filtered result.
  useEffect(() => { setPage(1); }, [start, end, sourceType, status, search, sort, dir, pageSize]);

  const load = useCallback(() => {
    setLoading(true);
    getJournalEntries({
      start, end, source_type: sourceType, status, q_text: search,
      sort, direction: dir,
      limit: pageSize, offset: (page - 1) * pageSize,
    })
      .then(setData)
      .catch(e => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  }, [start, end, sourceType, status, search, sort, dir, page, pageSize]);
  useEffect(() => { load(); }, [load]);

  function onSort(key) {
    if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDir('desc'); }
  }

  async function openDetail(id) {
    try { setDetail(await getJournalEntry(id)); } catch (e) { toast(e.message, 'red'); }
  }
  async function doReverse(id) {
    setConfirmRev(null);
    try { await reverseJournalEntry(id); toast(t('accounting.reversed')); setDetail(null); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  const rows         = data?.rows || [];
  const total        = data?.total || 0;
  const sourceTypes  = data?.source_types || [];

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span className="card-title">{t('accounting.journal')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {canCreate && <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>＋ {t('accounting.newEntry')}</button>}
        </div>
      </div>

      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)',
                    display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" className="form-control" style={{ width: 150 }} value={start} onChange={e => setStart(e.target.value)} />
        <span style={{ color: 'var(--text-3)' }}>→</span>
        <input type="date" className="form-control" style={{ width: 150 }} value={end} onChange={e => setEnd(e.target.value)} />
        <select className="form-control" style={{ width: 160 }} value={sourceType} onChange={e => setSourceType(e.target.value)}>
          <option value="">{t('accounting.allSources')}</option>
          {sourceTypes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="form-control" style={{ width: 140 }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">{t('accounting.allStatuses')}</option>
          <option value="posted">{t('accounting.statusPosted')}</option>
          <option value="reversed">{t('accounting.statusReversed')}</option>
        </select>
        <input className="form-control" style={{ minWidth: 180, flex: 1 }}
          placeholder={t('accounting.searchEntries') + '…'}
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {loading && !data ? <LoadingSpinner /> : rows.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('accounting.noEntries')}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <SortableTh label="#"                          sortKey="entry_number" sort={sort} dir={dir} onSort={onSort} />
              <SortableTh label={t('common.date')}           sortKey="entry_date"   sort={sort} dir={dir} onSort={onSort} />
              <th>{t('accounting.memo')}</th>
              <SortableTh label={t('accounting.source')}     sortKey="source_type"  sort={sort} dir={dir} onSort={onSort} />
              <SortableTh label={t('accounting.debit')}      sortKey="total_debit"  sort={sort} dir={dir} onSort={onSort} align="right" />
              <SortableTh label={t('accounting.credit')}     sortKey="total_credit" sort={sort} dir={dir} onSort={onSort} align="right" />
              <SortableTh label={t('common.status')}         sortKey="status"       sort={sort} dir={dir} onSort={onSort} />
            </tr></thead>
            <tbody>
              {rows.map(e => (
                <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(e.id)}>
                  <td className="text-mono">{e.entry_number}</td>
                  <td>{fmtDate(e.entry_date)}</td>
                  <td className="td-primary">{e.memo}</td>
                  <td><span className="badge badge-gray">{e.source_type || 'manual'}</span></td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(e.total_debit)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(e.total_credit)}</td>
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

      <Pager page={page} pageSize={pageSize} total={total}
        onPage={setPage} onSize={setPageSize} t={t} />

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
                <td><NumberInput min="0" step="0.01" className="form-control" style={{ textAlign: 'right' }}
                  value={l.debit} onChange={e => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                <td><NumberInput min="0" step="0.01" className="form-control" style={{ textAlign: 'right' }}
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

export { Journal };
