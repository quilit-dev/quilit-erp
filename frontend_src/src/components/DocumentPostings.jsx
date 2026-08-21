// What a document did to the books.
//
// The journal answers "where did this posting come from?". This is the same
// question asked from the other end — an operator looking at an invoice wants
// to know what it did to the ledger without learning that the answer lives
// under Accounting → Journal, filtered by a source type they have never heard
// of.
//
// Collapsed by default: it is reference material, not part of the document.
// Nothing is fetched until it is opened, so a screen that carries it pays
// nothing for the ones nobody expands.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getDocumentPostings } from '../api/client';
import { LoadingSpinner } from './shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';

export default function DocumentPostings({ document, id }) {
  const { t, fmt, fmtDate, tAccount, tEnumValue } = useLocale();
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Reading the ledger is a permission of its own. Someone who can raise an
  // invoice is not automatically someone who may read the books.
  if (!can('accounting', 'view') || !id) return null;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || data || loading) return;
    setLoading(true);
    getDocumentPostings(document, id)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  const entries = data?.entries || [];

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <button type="button" className="btn btn-sm btn-secondary" onClick={toggle}>
        {open ? '▾' : '▸'} {t('accounting.viewPostings')}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {loading && <LoadingSpinner />}
          {error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('accounting.noPostings')}</div>
          )}

          {entries.map(e => (
            <div key={e.id} className="card" style={{ marginBottom: 10 }}>
              <div className="card-header" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Link to={`/accounting?tab=journal&focus=${e.id}`}
                  style={{ fontWeight: 600, color: 'var(--accent)' }}>
                  {e.entry_number}
                </Link>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{fmtDate(e.entry_date)}</span>
                <span className="badge badge-gray">{tEnumValue(e.source_type || 'manual')}</span>
                {/* A reversed entry is part of the story, not something to
                    quietly drop from it. */}
                <span className={`badge badge-${e.status === 'posted' ? 'green'
                  : e.status === 'reversed' ? 'red' : 'gray'}`}>
                  {tEnumValue(e.status)}
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('accounting.account')}</th>
                      <th style={{ textAlign: 'right' }}>{t('accounting.debit')}</th>
                      <th style={{ textAlign: 'right' }}>{t('accounting.credit')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(e.lines || []).map(l => (
                      <tr key={l.id}>
                        <td><span className="text-mono">{l.account_code}</span> {tAccount(l)}</td>
                        <td style={{ textAlign: 'right' }}>{l.debit ? fmt(l.debit) : ''}</td>
                        <td style={{ textAlign: 'right' }}>{l.credit ? fmt(l.credit) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
