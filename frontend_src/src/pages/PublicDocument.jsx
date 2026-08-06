// The page a CLIENT sees when they open a link from an invoice or quotation
// email. No login, no sidebar, no app chrome — the recipient is not a user of
// this ERP and never will be, so anything that looks like an application is
// noise to them.
//
// It deliberately renders only what the public endpoint returns. That endpoint
// enumerates its payload by hand rather than spreading the row, so internal
// fields (costs, margins, private notes) cannot leak here by accident.
//
// Printing is the browser's job, same as everywhere else in this app — there is
// no server-side PDF, and window.print() gives the client a perfectly good one.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

const money = (n, cur) => `${cur || ''} ${Number(n || 0).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`.trim();

export default function PublicDocument() {
  const { token } = useParams();
  const [doc, setDoc] = useState(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/communications/public/${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(d => { if (alive) setDoc(d); })
      .catch(() => { if (alive) setGone(true); });
    return () => { alive = false; };
  }, [token]);

  if (gone) {
    return (
      <Shell>
        <h1 style={{ fontSize: 19, margin: '0 0 8px' }}>This link is no longer available</h1>
        <p style={{ color: 'var(--text-2)', margin: 0, fontSize: 14 }}>
          It may have expired or been replaced. Please ask your contact to send a new one.
        </p>
      </Shell>
    );
  }

  if (!doc) {
    return <Shell><p style={{ color: 'var(--text-3)', margin: 0 }}>Loading…</p></Shell>;
  }

  const subtotal = (doc.items || []).reduce(
    (s, i) => s + Number(i.quantity || 0) * Number(i.unit_price || 0), 0);

  return (
    <Shell wide>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{doc.company?.name}</div>
          {doc.company?.address && (
            <div style={{ fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-line' }}>
              {doc.company.address}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {[doc.company?.phone, doc.company?.email].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div style={{ textAlign: 'end' }}>
          <div style={{ fontSize: 13, letterSpacing: '.08em', textTransform: 'uppercase',
                        color: 'var(--text-3)' }}>{doc.label}</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{doc.number}</div>
          {doc.issued_at && (
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>Issued {doc.issued_at}</div>
          )}
          {doc.due_date && (
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>Due {String(doc.due_date).slice(0, 10)}</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 22, fontSize: 13, color: 'var(--text-3)' }}>Billed to</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{doc.client?.name}</div>

      {(doc.items || []).length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 18 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--rule)', textAlign: 'start' }}>
                <th style={{ textAlign: 'start', padding: '8px 0' }}>Description</th>
                <th style={{ textAlign: 'end', padding: '8px 0' }}>Qty</th>
                <th style={{ textAlign: 'end', padding: '8px 0' }}>Unit</th>
                <th style={{ textAlign: 'end', padding: '8px 0' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {doc.items.map((i, n) => (
                <tr key={n} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={{ padding: '8px 0' }}>{i.name}</td>
                  <td style={{ textAlign: 'end', padding: '8px 0' }}>{i.quantity}</td>
                  <td style={{ textAlign: 'end', padding: '8px 0' }}>{money(i.unit_price, doc.currency)}</td>
                  <td style={{ textAlign: 'end', padding: '8px 0' }}>
                    {money(Number(i.quantity || 0) * Number(i.unit_price || 0), doc.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <div style={{ minWidth: 220 }}>
          {/* The recorded total is authoritative. If it disagrees with the line
              sum (a manual adjustment, rounding, a discount held elsewhere) the
              document total is what the client owes — so show both rather than
              silently overriding one with the other. */}
          {Math.abs(subtotal - Number(doc.amount || 0)) > 0.01 && (
            <Row label="Lines" value={money(subtotal, doc.currency)} />
          )}
          <Row label="Total" value={money(doc.amount, doc.currency)} bold />
        </div>
      </div>

      {doc.notes && (
        <div style={{ marginTop: 20, fontSize: 13, color: 'var(--text-2)',
                      whiteSpace: 'pre-line' }}>{doc.notes}</div>
      )}

      <div className="no-print" style={{ marginTop: 26, display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={() => window.print()}>Print / Save PDF</button>
      </div>
    </Shell>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0',
                  fontWeight: bold ? 700 : 400,
                  fontSize: bold ? 16 : 14,
                  borderTop: bold ? '1px solid var(--rule)' : undefined }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

function Shell({ children, wide }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: '32px 16px' }}>
      <div className="card" style={{ maxWidth: wide ? 780 : 460, margin: '0 auto',
                                     padding: '28px 26px' }}>
        {children}
      </div>
    </div>
  );
}
