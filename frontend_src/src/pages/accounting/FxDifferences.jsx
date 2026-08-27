// Currency differences — the workspace a period is closed in.
//
// The question each row answers is not "how much": the ledger already says
// that. It is *what happened here*. Which document, agreed in what currency,
// recognised at which rate, worth what in the company's money, settled or
// revalued at which rate, worth what then — and therefore this difference,
// carried by that entry, read by that person.
//
// Realised and unrealised are kept visibly apart. A realised difference means
// the money arrived and the company genuinely has more or less of it. An
// unrealised one means nothing moved and the holding is simply worth something
// else today; it reverses itself when the rate comes back. Presenting them as
// one number would misstate what the period earned.
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  getFxDifferences, reconcileFxDifference, getClients, getAccounts,
} from '../../api/client';
import { LoadingSpinner, EmptyState, Modal, toast } from '../../components/shared';
import { ExportButtons } from '../reports/charts';
import { CURRENCIES } from '../settings/ui';
import { monthStartISO, todayISO } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

function FxDifferences({ t, fmt, fmtDate, can }) {
  const canReconcile = can('accounting', 'edit');
  const [start, setStart] = useState(monthStartISO());
  const [end,   setEnd]   = useState(todayISO());
  const [kind, setKind] = useState('');
  const [currency, setCurrency] = useState('');
  const [direction, setDirection] = useState('');
  const [clientId, setClientId] = useState('');
  const [status, setStatus] = useState('');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [clients, setClients] = useState([]);
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getFxDifferences({
      start, end,
      ...(kind ? { kind } : {}),
      ...(currency ? { currency } : {}),
      ...(direction ? { direction } : {}),
      ...(clientId ? { client_id: clientId } : {}),
      ...(status ? { status } : {}),
    })
      .then(setData)
      .catch(e => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  }, [start, end, kind, currency, direction, clientId, status]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getClients().then(r => setClients(r?.rows || r || [])).catch(() => {});
    getAccounts({ active: true }).catch(() => {});
  }, []);

  async function mark(row, undo) {
    setBusy(true);
    try {
      await reconcileFxDifference(row.kind, row.ref_id, {
        note: undo ? null : (note.trim() || null), undo,
      });
      toast(t(undo ? 'fx.unmarked' : 'fx.marked'));
      setDetail(null); setNote('');
      load();
    } catch (e) {
      toast(e.message, 'red');
    } finally { setBusy(false); }
  }

  const rows = data?.rows || [];
  const sum  = data?.summary || {};

  // The same columns the table shows, so an exported workbook says exactly
  // what the screen says.
  const columns = [
    { label: t('common.date'),           value: r => fmtDate(r.occurred_at), align: 'left' },
    { label: t('fx.kind'),               value: r => t(`fx.kind_${r.kind}`), align: 'left' },
    { label: t('common.client'),         value: r => r.client_name || '', align: 'left' },
    { label: t('reports.invoiceNumber'), value: r => r.invoice_number || r.account_code || '', align: 'left' },
    { label: t('invoices.paymentCurrency'), value: r => r.currency || '', align: 'left' },
    { label: t('fx.recognitionRate'),    value: r => r.recognition_rate ?? '', align: 'right' },
    { label: t('fx.settlementRate'),     value: r => r.settlement_rate ?? '', align: 'right' },
    { label: t('fx.baseAtRecognition'),  value: r => r.base_at_recognition, align: 'right' },
    { label: t('fx.baseAtSettlement'),   value: r => r.base_at_settlement, align: 'right' },
    { label: t('fx.difference'),         value: r => r.difference, align: 'right' },
    { label: t('accounting.journal'),    value: r => r.entry_number || '', align: 'left' },
    { label: t('fx.reconciled'),         value: r => (r.reconciled ? 'Yes' : 'No'), align: 'left' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <Tile label={t('fx.realizedTotal')} value={fmt(sum.realized || 0)}
              hint={t('fx.realizedHint')} />
        <Tile label={t('fx.unrealizedTotal')} value={fmt(sum.unrealized || 0)}
              hint={t('fx.unrealizedHint')} />
        <Tile label={t('fx.netTotal')} value={fmt(sum.net || 0)}
              colour={(sum.net || 0) >= 0 ? 'green' : 'red'} />
        <Tile label={t('fx.stillToReview')} value={String(sum.unreconciled ?? 0)}
              colour={(sum.unreconciled || 0) > 0 ? 'red' : 'green'} />
      </div>

      <div className="card">
        <div className="card-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <div className="search-bar" style={{ margin: 0, flexWrap: 'wrap' }}>
            <span className="card-title" style={{ marginInlineEnd: 'auto' }}>
              {t('fx.title')}
            </span>
            <input type="date" className="form-control" style={{ width: 150 }}
              value={start} onChange={e => setStart(e.target.value)}
              aria-label={t('service.dateFrom')} title={t('service.dateFrom')} />
            <input type="date" className="form-control" style={{ width: 150 }}
              value={end} onChange={e => setEnd(e.target.value)}
              aria-label={t('service.dateTo')} title={t('service.dateTo')} />
            <SearchSelect
              className="form-control"
              style={{ width: 140 }}
              value={kind}
              onChange={v => setKind(v)}
              placeholder={t('fx.allKinds')}
              options={[{ value: 'realized', label: t('fx.kind_realized') }, { value: 'unrealized', label: t('fx.kind_unrealized') }]} />
            <SearchSelect
              className="form-control"
              style={{ width: 110 }}
              value={currency}
              onChange={v => setCurrency(v)}
              placeholder={t('fx.allCurrencies')}
              options={(CURRENCIES).map(c => ({ value: c, label: c }))} />
            <SearchSelect
              className="form-control"
              style={{ width: 120 }}
              value={direction}
              onChange={v => setDirection(v)}
              placeholder={t('fx.gainOrLoss')}
              options={[{ value: 'gain', label: t('fx.gain') }, { value: 'loss', label: t('fx.loss') }]} />
            <SearchSelect
              className="form-control"
              style={{ width: 170 }}
              value={clientId}
              onChange={v => setClientId(v)}
              placeholder={t('fx.allCustomers')}
              options={(clients || []).map(c => ({ value: c.id, label: c.name }))} />
            <SearchSelect
              className="form-control"
              style={{ width: 150 }}
              value={status}
              onChange={v => setStatus(v)}
              placeholder={t('fx.anyStatus')}
              options={[{ value: 'open', label: t('fx.stillToReview') }, { value: 'reconciled', label: t('fx.reconciled') }, { value: 'reversed', label: t('accounting.statusReversed') }]} />
            {(kind || currency || direction || clientId || status) && (
              <button type="button" className="btn btn-secondary btn-sm"
                style={{ whiteSpace: 'nowrap' }}
                onClick={() => { setKind(''); setCurrency(''); setDirection('');
                                 setClientId(''); setStatus(''); }}>
                ✕ {t('common.clear')}
              </button>
            )}
            <ExportButtons rows={rows} columns={columns}
              baseName="fx-differences" pdfTitle={t('fx.title')} t={t} />
          </div>
        </div>

        {loading && !data ? <LoadingSpinner /> : rows.length === 0 ? (
          <EmptyState message={t('fx.none')} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('fx.kind')}</th>
                  <th>{t('fx.source')}</th>
                  <th>{t('invoices.paymentCurrency')}</th>
                  <th className="text-right">{t('fx.rates')}</th>
                  <th className="text-right">{t('fx.baseAtRecognition')}</th>
                  <th className="text-right">{t('fx.baseAtSettlement')}</th>
                  <th className="text-right">{t('fx.difference')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={`${r.kind}-${r.ref_id}`} style={{ cursor: 'pointer' }}
                      onClick={() => { setDetail(r); setNote(r.reconcile_note || ''); }}>
                    <td>{fmtDate(r.occurred_at)}</td>
                    <td>
                      <span className={`badge badge-${r.kind === 'realized' ? 'blue' : 'yellow'}`}>
                        {t(`fx.kind_${r.kind}`)}
                      </span>
                    </td>
                    <td>
                      <div className="td-primary">
                        {r.invoice_number || r.account_name || r.account_code || '—'}
                      </div>
                      {r.client_name && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.client_name}</div>
                      )}
                    </td>
                    <td>{r.currency}</td>
                    {/* Both rates together: the difference is the gap between
                        them, and reading one without the other says nothing. */}
                    <td className="text-right text-mono" style={{ fontSize: 12 }}>
                      {r.recognition_rate != null ? r.recognition_rate : '—'}
                      {' → '}
                      {r.settlement_rate != null ? r.settlement_rate : '—'}
                    </td>
                    <td className="text-right">{fmt(r.base_at_recognition)}</td>
                    <td className="text-right">{fmt(r.base_at_settlement)}</td>
                    <td className="text-right" style={{
                      fontWeight: 600,
                      color: r.difference >= 0 ? 'var(--green)' : 'var(--red)',
                    }}>{fmt(r.difference)}</td>
                    <td>
                      <span className={`badge badge-${r.reconciled ? 'green' : 'gray'}`}>
                        {t(r.reconciled ? 'fx.reconciled' : 'fx.stillToReview')}
                      </span>
                      {r.posting_status === 'reversed' && (
                        <span className="badge badge-red" style={{ marginInlineStart: 6 }}>
                          {t('accounting.statusReversed')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail && (
        <DifferenceDetail row={detail} t={t} fmt={fmt} fmtDate={fmtDate}
          note={note} setNote={setNote} busy={busy} canReconcile={canReconcile}
          onClose={() => setDetail(null)} onMark={mark} />
      )}
    </div>
  );
}

function Tile({ label, value, hint, colour }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={colour ? { color: `var(--${colour})` } : undefined}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{hint}</div>}
    </div>
  );
}

/** The whole chain for one difference, in the order it happened. */
function DifferenceDetail({ row, t, fmt, fmtDate, note, setNote, busy,
                            canReconcile, onClose, onMark }) {
  const steps = [
    [t('fx.stepDocument'), row.invoice_number || row.account_name || row.account_code || '—'],
    [t('fx.stepAgreed'), row.invoice_txn_amount != null
      ? `${row.currency} ${fmt(row.invoice_txn_amount)}`
      : `${row.currency} ${fmt(row.tender_amount)}`],
    [t('fx.stepRecognitionRate'), row.recognition_rate != null
      ? String(row.recognition_rate) : t('fx.notApplicable')],
    [t('fx.stepBaseAtRecognition'), fmt(row.base_at_recognition)],
    [t('fx.stepLaterRate'), String(row.settlement_rate ?? '—')],
    [t('fx.stepValueThen'), fmt(row.base_at_settlement)],
    [t('fx.stepDifference'), fmt(row.difference)],
    [t('fx.stepTreatment'), row.entry_number || t('fx.notPosted')],
  ];

  return (
    <Modal title={t('fx.detailTitle')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 0 }}>
          {t(row.kind === 'realized' ? 'fx.realizedHint' : 'fx.unrealizedHint')}
        </p>
        <table>
          <tbody>
            {steps.map(([label, value]) => (
              <tr key={label}>
                <td style={{ color: 'var(--text-3)', width: '45%' }}>{label}</td>
                <td className="td-primary">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {row.journal_entry_id && (
          <div style={{ marginTop: 12 }}>
            <Link to={`/accounting?tab=journal&focus=${row.journal_entry_id}`}
              onClick={onClose} style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {t('accounting.viewPostings')}
            </Link>
          </div>
        )}

        <div className="form-group form-full" style={{ marginTop: 16 }}>
          <label className="form-label">{t('fx.reviewNote')}</label>
          <input className="form-control" value={note} disabled={!canReconcile}
            onChange={e => setNote(e.target.value)} />
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
            {t('fx.reviewHint')}
          </div>
        </div>

        {row.reconciled && (
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {t('fx.reviewedBy', {
              name: row.reconciled_by_name || '—',
              date: fmtDate(row.reconciled_at),
            })}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {canReconcile && (row.reconciled ? (
          <button className="btn btn-secondary" disabled={busy}
            onClick={() => onMark(row, true)}>{t('fx.unmark')}</button>
        ) : (
          <button className="btn btn-primary" disabled={busy}
            onClick={() => onMark(row, false)}>{t('fx.mark')}</button>
        ))}
      </div>
    </Modal>
  );
}

export { FxDifferences };
