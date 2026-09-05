// The page a CLIENT sees when they open a share link from WhatsApp or email.
// No login, no sidebar, no app chrome — the recipient is not a user of this ERP
// and never will be, so anything that looks like an application is noise.
//
// It renders THE SAME document the supplier prints, from the same template in
// exportUtils.js. It used to have a simplified layout of its own, so the copy a
// customer opened looked nothing like the invoice they were told had been sent —
// different fonts, no logo, no bank details, no line discounts. One template,
// two audiences.
//
// The document goes in an IFRAME rather than into the page. That template is a
// whole HTML document with its own reset and print rules; injecting its markup
// here would let the app's stylesheet reshape a financial document, and the
// customer would receive something subtly different from what was sent. An
// iframe also makes printing exact — the browser prints the frame's own @page
// rules, not this page's.
//
// It still renders only what the public endpoint returns, and that endpoint
// enumerates its payload by hand rather than spreading the row, so internal
// fields (costs, margins, private notes) cannot leak here by accident.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { buildInvoiceHTML, buildQuotationHTML, getLogoDataURL } from '../utils/exportUtils';

export default function PublicDocument() {
  const { token } = useParams();
  const [doc, setDoc] = useState(null);
  const [gone, setGone] = useState(false);
  // undefined = still resolving, null = there is no logo. The document waits
  // for this rather than rendering logo-less and then reflowing once it lands.
  const [logo, setLogo] = useState(undefined);
  const frameRef = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/communications/public/${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(d => { if (alive) setDoc(d); })
      .catch(() => { if (alive) setGone(true); });
    return () => { alive = false; };
  }, [token]);

  // Resolve the logo to a data URL exactly as the supplier's own export does.
  // It answers null when nothing has been uploaded, which is what makes the
  // template drop the <img> instead of printing a broken image.
  useEffect(() => {
    let alive = true;
    getLogoDataURL()
      .then(d => { if (alive) setLogo(d || null); })
      .catch(() => { if (alive) setLogo(null); });
    return () => { alive = false; };
  }, []);

  // Build the document with the shared template. The public payload already
  // carries the settings-shaped company block, so nothing here needs a session.
  const html = useMemo(() => {
    if (!doc || logo === undefined) return '';
    // The public payload names the reference `number`; the template reads
    // `invoice_number` / `quote_number`. Without this the client's copy shows a
    // dash where the document reference belongs — the one field they quote back
    // when they pay or query it.
    const shaped = {
      ...doc,
      invoice_number: doc.number,
      quote_number: doc.number,
    };
    try {
      const built = doc.type === 'quotation'
        ? buildQuotationHTML(shaped, doc.company || {}, logo)
        : buildInvoiceHTML(shaped, doc.company || {}, logo);
      return built?.html || '';
    } catch {
      return '';        // never leave the client staring at a blank page
    }
  }, [doc, logo]);

  function printDoc() {
    const w = frameRef.current?.contentWindow;
    if (!w) return;
    w.focus();
    w.print();
  }

  if (gone) {
    return (
      <Shell>
        <h1 style={{ fontSize: 19, margin: '0 0 8px' }}>This link is no longer available</h1>
        <p style={{ color: 'var(--doc-ink-2)', margin: 0, fontSize: 14 }}>
          It may have expired or been replaced. Please ask your contact to send a new one.
        </p>
      </Shell>
    );
  }

  // Still resolving either half. `logo === undefined` matters as much as a
  // missing doc: without it the "could not be displayed" panel below flashes up
  // for a moment on every single visit, because the template cannot be built
  // until the logo has settled one way or the other.
  if (!doc || logo === undefined) {
    return <Shell><p style={{ color: 'var(--doc-ink-3)', margin: 0 }}>Loading…</p></Shell>;
  }

  if (!html) {
    return (
      <Shell>
        <h1 style={{ fontSize: 19, margin: '0 0 8px' }}>
          {doc.label} {doc.number}
        </h1>
        <p style={{ color: 'var(--doc-ink-2)', margin: 0, fontSize: 14 }}>
          This document could not be displayed. Please ask your contact to resend it.
        </p>
      </Shell>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--doc-ground)', padding: '16px 12px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', gap: 12, marginBottom: 12,
                      flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--doc-ink-2)' }}>
            {doc.label} <strong>{doc.number}</strong>
            {doc.company?.name ? ` · ${doc.company.name}` : ''}
          </div>
          {/* Print is the only action a recipient needs. "Save as PDF" lives
              inside the browser's own print dialog on every platform. */}
          <button onClick={printDoc}
            style={{ background: 'var(--doc-accent)', color: 'var(--doc-paper)', border: 0,
                     borderRadius: 8, padding: '9px 16px', fontSize: 13.5,
                     fontWeight: 600, cursor: 'pointer' }}>
            Print / Save as PDF
          </button>
        </div>

        <iframe
          ref={frameRef}
          title={`${doc.label} ${doc.number || ''}`.trim()}
          srcDoc={html}
          onLoad={(e) => {
            // Grow the frame to its content so the page scrolls once, rather
            // than the customer scrolling inside a small window.
            try {
              const d = e.currentTarget.contentDocument;
              const h = Math.max(d.body.scrollHeight, d.documentElement.scrollHeight);
              e.currentTarget.style.height = `${h + 40}px`;
            } catch {
              e.currentTarget.style.height = '1200px';
            }
          }}
          style={{ width: '100%', border: 0, borderRadius: 10, background: 'var(--doc-paper)',
                   boxShadow: '0 1px 3px rgba(0,0,0,.12)', minHeight: 600 }}
        />
      </div>
    </div>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: 'var(--doc-ground)', padding: 24 }}>
      <div style={{ background: 'var(--doc-paper)', borderRadius: 12, padding: '34px 30px',
                    maxWidth: 460, width: '100%', textAlign: 'center',
                    boxShadow: '0 1px 3px rgba(0,0,0,.12)',
                    font: '15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}>
        {children}
      </div>
    </div>
  );
}
