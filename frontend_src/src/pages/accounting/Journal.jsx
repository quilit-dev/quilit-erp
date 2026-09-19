import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useFocusId } from '../../hooks/useFocusId';
import {
  getAccounts, getJournalEntries, getJournalEntry,
  createJournalEntry, reverseJournalEntry, reclassifyJournalEntry,
} from '../../api/client';
import { LoadingSpinner, Modal, ConfirmModal, toast, NumberInput } from '../../components/shared';
import { monthStartISO, todayISO } from './constants';
import { SortableTh, Pager } from './ui';
import SearchSelect from '../../components/SearchSelect.jsx';

// ── Journal ──────────────────────────────────────────────────────────────────
//
// Server-paged (the backend now returns {rows, total, source_types}). Every
// filter change resets the cursor to page 1 so the operator isn't stranded
// past the end of a freshly-filtered result set.
function Journal({ t, tAccount, tEnumValue, fmt, fmtDate, canCreate, canEdit }) {
  const [start, setStart]               = useState(monthStartISO());
  const [end,   setEnd]                 = useState(todayISO());
  const [sourceType, setSourceType]     = useState('');
  const [status,     setStatus]         = useState('');
  const [search,     setSearch]         = useState('');
  const [accountId,  setAccountId]      = useState('');
  const [minAmount,  setMinAmount]      = useState('');
  const [maxAmount,  setMaxAmount]      = useState('');
  const [accounts,   setAccounts]       = useState([]);
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
  useEffect(() => { setPage(1); }, [start, end, sourceType, status, search,
                                    accountId, minAmount, maxAmount, sort, dir, pageSize]);

  // The account filter needs the chart; it is small and changes rarely.
  useEffect(() => { getAccounts({ active: true }).then(setAccounts).catch(() => {}); }, []);

  const load = useCallback(() => {
    setLoading(true);
    getJournalEntries({
      start, end, source_type: sourceType, status, q_text: search,
      ...(accountId ? { account_id: accountId } : {}),
      ...(minAmount !== '' ? { min_amount: minAmount } : {}),
      ...(maxAmount !== '' ? { max_amount: maxAmount } : {}),
      sort, direction: dir,
      limit: pageSize, offset: (page - 1) * pageSize,
    })
      .then(setData)
      .catch(e => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  }, [start, end, sourceType, status, search, accountId, minAmount, maxAmount,
      sort, dir, page, pageSize]);
  useEffect(() => { load(); }, [load]);

  function onSort(key) {
    if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDir('desc'); }
  }

  // Arriving from the global search as ?tab=journal&focus=<id>. The entry may
  // be on any page of any date range, so it is fetched directly rather than
  // hunted for in the rows on screen.
  const [focusId, clearFocus] = useFocusId();
  useEffect(() => {
    if (focusId == null) return;
    getJournalEntry(focusId).then(setDetail).catch(e => toast(e.message, 'red'));
    clearFocus();
  }, [focusId]);

  async function openDetail(id) {
    try { setDetail(await getJournalEntry(id)); } catch (e) { toast(e.message, 'red'); }
  }
  // The reclassification form over the open entry.
  const [reclassifying, setReclassifying] = useState(false);

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
        <SearchSelect
          className="form-control"
          style={{ width: 160 }}
          value={sourceType}
          onChange={v => setSourceType(v)}
          placeholder={t('accounting.allSources')}
          options={(sourceTypes).map(s => ({ value: s, label: tEnumValue(s) }))} />
        <SearchSelect
          className="form-control"
          style={{ width: 140 }}
          value={status}
          onChange={v => setStatus(v)}
          placeholder={t('accounting.allStatuses')}
          options={[{ value: 'posted', label: t('accounting.statusPosted') }, { value: 'reversed', label: t('accounting.statusReversed') }]} />
        <input className="form-control" style={{ minWidth: 180, flex: 1 }}
          placeholder={t('accounting.searchEntries') + '…'}
          value={search} onChange={e => setSearch(e.target.value)} />
        {/* "Everything that touched 4111, between 500 and 5,000" — the two
            questions the journal could not previously be asked. */}
        <SearchSelect
          className="form-control"
          style={{ width: 190 }}
          value={accountId}
          onChange={v => setAccountId(v)}
          placeholder={t('accounting.allAccounts')}
          options={(accounts || []).map(a => ({ value: a.id, label: tAccount(a), hint: a.code }))} />
        <NumberInput className="form-control" style={{ width: 110 }} min="0" step="0.01"
          placeholder={t('accounting.minAmount')}
          value={minAmount} onChange={e => setMinAmount(e.target.value)} />
        <NumberInput className="form-control" style={{ width: 110 }} min="0" step="0.01"
          placeholder={t('accounting.maxAmount')}
          value={maxAmount} onChange={e => setMaxAmount(e.target.value)} />
        {(search || accountId || minAmount !== '' || maxAmount !== '' || sourceType || status) && (
          <button type="button" className="btn btn-secondary btn-sm"
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => { setSearch(''); setAccountId(''); setMinAmount('');
                             setMaxAmount(''); setSourceType(''); setStatus(''); }}>
            ✕ {t('common.clear')}
          </button>
        )}
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
                  <td>
                    <span className="badge badge-gray">{tEnumValue(e.source_type || 'manual')}</span>
                    {/* The document number, so the ledger reads as documents
                        rather than as source-type codes. */}
                    {e.source?.label && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                        {e.source.label}
                      </div>
                    )}
                  </td>
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

      {detail && !reclassifying && (
        <EntryDetail tAccount={tAccount} tEnumValue={tEnumValue} entry={detail} t={t} fmt={fmt} fmtDate={fmtDate} canEdit={canEdit}
          onClose={() => setDetail(null)} onReverse={() => setConfirmRev(detail.id)}
          onReclassify={() => setReclassifying(true)} onOpen={openDetail} />
      )}
      {detail && reclassifying && (
        <ReclassifyModal entry={detail} accounts={accounts} t={t} tAccount={tAccount} fmt={fmt}
          onClose={() => setReclassifying(false)}
          onSaved={async (newId) => { setReclassifying(false); load(); await openDetail(newId); }} />
      )}
      {adding && (
        <NewEntryModal tAccount={tAccount} t={t} fmt={fmt} onClose={() => setAdding(false)}
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

function EntryDetail({ entry, t, tAccount, tEnumValue, fmt, fmtDate, canEdit, onClose, onReverse, onReclassify, onOpen }) {
  const live = entry.status === 'posted' && !entry.reversed_by;
  // An entry a document produced is taken off the books by voiding the
  // document, not here; the server refuses a bare reverse on it. What the
  // accountant can do to any live entry is move a wrongly booked amount.
  const fromDocument = !!entry.source_type && entry.source_type !== 'manual';
  const reversible = live && !fromDocument;
  return (
    <Modal title={`${entry.entry_number} · ${fmtDate(entry.entry_date)}`} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 0 }}>{entry.memo}</p>
        {entry.source && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
                        fontSize: 13 }}>
            <span style={{ color: 'var(--text-3)' }}>{t('accounting.fromDocument')}:</span>
            {entry.source.route ? (
              <Link to={entry.source.route} onClick={onClose}
                style={{ color: 'var(--accent)', fontWeight: 600 }}>
                {entry.source.label}
              </Link>
            ) : (
              /* No route: the document is gone, or was never a document. Say
                 so rather than offering a link that goes nowhere. */
              <span>
                {entry.source.label || tEnumValue(entry.source.type)}
                {entry.source.exists === false && (
                  <span style={{ color: 'var(--text-3)', marginInlineStart: 6 }}>
                    ({t('accounting.documentGone')})
                  </span>
                )}
              </span>
            )}
          </div>
        )}
        {/* The correction chain, from either end. */}
        {entry.reclassifies && (
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            <span style={{ color: 'var(--text-3)' }}>{t('accounting.reclassifiesLabel')}:</span>{' '}
            <button type="button" className="btn-link" onClick={() => onOpen(entry.reclassifies.id)}
              style={{ color: 'var(--accent)', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              {entry.reclassifies.entry_number}
            </button>
          </div>
        )}
        {entry.reclassified_by?.length > 0 && (
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            <span style={{ color: 'var(--text-3)' }}>{t('accounting.reclassifiedByLabel')}:</span>{' '}
            {entry.reclassified_by.map((r, i) => (
              <span key={r.id}>
                {i > 0 && ', '}
                <button type="button" onClick={() => onOpen(r.id)}
                  style={{ color: 'var(--accent)', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  {r.entry_number}
                </button>
                <span style={{ color: 'var(--text-3)' }}> ({fmt(r.total_debit)})</span>
              </span>
            ))}
          </div>
        )}
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
                  <td><span className="text-mono">{l.account_code}</span> {tAccount(l)}</td>
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
        {canEdit && live && <button className="btn btn-secondary" onClick={onReclassify}>{t('accounting.reclassify')}</button>}
        {canEdit && reversible && <button className="btn btn-danger" onClick={onReverse}>{t('accounting.reverse')}</button>}
        {canEdit && live && fromDocument && (
          <span style={{ fontSize: 12, color: 'var(--text-3)', marginInlineEnd: 'auto' }}>
            {t('accounting.reverseViaDocument')}
          </span>
        )}
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  );
}


// Move an amount this entry posted to the wrong account onto the right one.
// A new balancing entry is posted and linked; the posted lines stay as they
// are, so the trial balance anyone printed from them stays true.
function ReclassifyModal({ entry, accounts, t, tAccount, fmt, onClose, onSaved }) {
  // The accounts on this entry, netted: the accountant picks which one is wrong.
  const onEntry = Object.values((entry.lines || []).reduce((acc, l) => {
    const cur = acc[l.account_id] || { account_id: l.account_id, code: l.account_code, line: l, net: 0 };
    cur.net += (Number(l.debit) || 0) - (Number(l.credit) || 0);
    acc[l.account_id] = cur;
    return acc;
  }, {})).filter(a => Math.abs(a.net) > 0.004);
  const [fromId, setFromId] = useState(onEntry.length === 1 ? String(onEntry[0].account_id) : '');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const from = onEntry.find(a => String(a.account_id) === fromId);
  const max = from ? Math.abs(from.net) : 0;
  const moving = amount === '' ? max : Number(amount);
  const ok = fromId && toId && toId !== fromId && moving > 0 && moving <= max + 0.005 && reason.trim();

  async function submit(e) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    try {
      const res = await reclassifyJournalEntry(entry.id, {
        from_account_id: Number(fromId), to_account_id: Number(toId),
        amount: amount === '' ? null : Number(amount), entry_date: date, reason: reason.trim(),
      });
      toast(t('accounting.reclassified'));
      onSaved(res.id);
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`${t('accounting.reclassify')} · ${entry.entry_number}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 0 }}>{t('accounting.reclassifyHint')}</p>
          <div className="form-grid">
            <div className="form-group form-full">
              <label className="form-label">{t('accounting.reclassFrom')}</label>
              <SearchSelect className="form-control" value={fromId} onChange={setFromId} allowBlank={false}
                placeholder={t('accounting.pickAccount')}
                options={onEntry.map(a => ({ value: String(a.account_id),
                  label: `${a.code} ${tAccount(a.line)}`,
                  hint: `${a.net > 0 ? t('accounting.debit') : t('accounting.credit')} ${fmt(Math.abs(a.net))}` }))} />
            </div>
            <div className="form-group form-full">
              <label className="form-label">{t('accounting.reclassTo')}</label>
              <SearchSelect className="form-control" value={toId} onChange={setToId} allowBlank={false}
                placeholder={t('accounting.pickAccount')} searchable
                options={(accounts || []).filter(a => a.is_postable !== 0 && a.is_postable !== false
                                                   && String(a.id) !== fromId)
                  .map(a => ({ value: String(a.id), label: `${a.code} ${tAccount(a)}` }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('common.amount')}</label>
              <NumberInput className="form-control" min="0.01" step="0.01" max={max} value={amount}
                onChange={e => setAmount(e.target.value)} placeholder={from ? `${fmt(max)} (${t('accounting.wholeLine')})` : ''} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('common.date')}</label>
              <input type="date" className="form-control" value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div className="form-group form-full">
              <label className="form-label">{t('accounting.reclassReason')}</label>
              <input className="form-control" value={reason} onChange={e => setReason(e.target.value)}
                placeholder={t('accounting.reclassReasonPlaceholder')} autoFocus />
            </div>
          </div>
          {from && toId && moving > 0 && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-2)' }}>
              {t('accounting.reclassPreview', { amount: fmt(moving) })}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !ok}>
            {busy ? t('common.saving') : t('accounting.postReclass')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewEntryModal({ t, tAccount, fmt, onClose, onSaved }) {
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
                  <SearchSelect
                    className="form-control"
                    value={l.account_id}
                    onChange={v => setLine(i, { account_id: v })}
                    placeholder={t('accounting.selectAccount')}
                    options={(accounts || []).map(a => ({ value: a.id, label: tAccount(a), hint: a.code }))} />
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
