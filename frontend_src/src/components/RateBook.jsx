// The rate book — in the top bar, next to the notification bell.
//
// Placed here rather than buried in Settings because of how often it is used
// and by whom. In Lebanon the pound rate moves week to week and sometimes day
// to day; every operator needs to KNOW the rate that the till and the invoice
// will convert at, and an administrator needs to change it without leaving the
// page they are working on. Settings is the right home for something set once
// a year, and the wrong one for this.
//
// Two decisions inside are worth stating, because they are what keep the books
// consistent.
//
// ONE NUMBER PER CURRENCY, EVERY PAIR DERIVED. Six directions between three
// currencies is three facts and three reciprocals. Typed separately they drift:
// 1 USD = 89,000 LBP entered beside 1 LBP = 0.0000112 USD does not round-trip,
// and two invoices dated the same day convert differently depending on which
// way round the operator happened to think. So the panel shows all six and
// stores one — and the operator may still TYPE either direction, because
// whichever way they think in, it is inverted before it is stored.
//
// A DATE ON EVERY CHANGE. That is what the accountant is actually asking for:
// not what the rate is, but when it became that. The date decides which rate a
// new conversion picks up; nothing already posted moves, because those amounts
// were converted when they were written.
import { useState, useEffect, useCallback, useRef } from 'react';
import { getExchangeRate, setExchangeRate } from '../api/client';
import { NumberInput, toast, Icon } from './shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSettings } from '../hooks/useSettings.jsx';
import { usePermissions } from '../hooks/usePermissions';
import { useScrollLock } from '../hooks/useScrollLock';

const today = () => new Date().toISOString().slice(0, 10);

// A rate is a rate whether it reads 89,000 or 0.0000112, and both are worth
// showing plainly rather than in exponent form.
function fmtRate(v) {
  const n = Number(v) || 0;
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

// How long a rate can stand before it stops describing anything. Same seven
// days the stale-rate notification uses, so the dot and the alert agree.
const STALE_DAYS = 7;

// The currencies a rate can be set for. USD is the book's own currency and
// is 1 by definition, so it is never in the list.
const SUPPORTED = ['LBP', 'EUR'];

function ageInDays(iso) {
  if (!iso) return null;
  const then = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

// The panel itself: the rates, the form and the history. Rendered inside the
// top-bar popover and again on the Settings page, because a second
// implementation of "set the rate" is a second answer to what a rate is — and
// the one Settings used to carry had no currency and no date, so a rate set
// there could not be found by the effective-dated lookup it was meant to feed.
export function RateBookPanel({ onClose }) {
  const { t, fmtDate } = useLocale();
  const { reload } = useSettings();
  // Setting a rate is editing a setting, and the endpoint behind this form
  // says so. Admin-tier reaches it, and so does a role granted `settings:
  // edit` — the same rule the Settings page follows, because this panel is
  // rendered there too and two answers to "who may type a rate" is one answer
  // too many.
  const { isAdmin, can } = usePermissions();
  const canEdit = isAdmin || can('settings', 'edit');
  const [book, setBook] = useState(null);
  const [busy, setBusy] = useState(false);

  // Which way round the operator is typing. The store is always "units per 1
  // USD"; entering it the other way is a convenience, not a second rate.
  const [form, setForm] = useState({
    currency: '', invert: false, rate: '', effective_date: today(), note: '',
  });

  const load = useCallback(() => {
    getExchangeRate().then(setBook).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const base = book?.base_currency || 'USD';
  const rates = book?.rates || {};
  const pairs = book?.pairs || [];
  const foreign = Object.keys(rates);

  useEffect(() => {
    if (!form.currency && foreign.length) {
      setForm(f => ({ ...f, currency: foreign[0] }));
    }
  }, [foreign.join(','), form.currency]);

  async function save(e) {
    e.preventDefault();
    const typed = Number(form.rate);
    if (!typed || typed <= 0) { toast(t('rates.needRate'), 'red'); return; }
    if (!form.currency) { toast(t('rates.needCurrency'), 'red'); return; }
    setBusy(true);
    try {
      // Typed as "X per 1 USD" or "USD per 1 X" — stored the one way either
      // way, so the two directions can never disagree.
      const perUsd = form.invert ? 1 / typed : typed;
      await setExchangeRate({
        rate: perUsd,
        currency: form.currency,
        effective_date: form.effective_date || today(),
        note: form.note.trim() || null,
      });
      toast(t('rates.saved'), 'green');
      setForm(f => ({ ...f, rate: '', note: '' }));
      load();
      reload?.();                    // the badge and the till pick it up
      onClose?.();
    } catch (err) {
      toast(err.message, 'red');
    } finally { setBusy(false); }
  }

  const settable = SUPPORTED.filter(c => c !== base);

  return (
    <>
      {/* Every direction, so nobody has to do the division in their head —
          and each one dated, which is the question an accountant actually
          asks of a rate. */}
      {pairs.length === 0 ? (
        <div className="notif-empty"><p>{t('rates.empty')}</p></div>
      ) : (
        <table style={{ width: '100%', fontSize: 12 }}>
          <tbody>
            {pairs.map(p => (
              <tr key={`${p.from}-${p.to}`}>
                <td style={{ padding: '6px 14px', whiteSpace: 'nowrap' }}>
                  1 {p.from} =
                </td>
                <td style={{ padding: '6px 0', fontWeight: 600,
                             fontFeatureSettings: '"tnum"' }}>
                  {fmtRate(p.rate)} {p.to}
                </td>
                <td style={{ padding: '6px 14px', textAlign: 'end',
                             color: 'var(--text-3)', fontSize: 11,
                             whiteSpace: 'nowrap' }}>
                  {p.derived && (
                    <span title={t('rates.derivedHint')}
                          style={{ marginInlineEnd: 6 }}>
                      {t('rates.derived')}
                    </span>
                  )}
                  {p.since ? fmtDate(p.since) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canEdit && (
        <form onSubmit={save} style={{ padding: 14, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end',
                        flexWrap: 'wrap' }}>
            <div className="form-group" style={{ margin: 0, width: 84 }}>
              <label className="form-label">{t('rates.currency')}</label>
              <select className="form-control" value={form.currency}
                onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
                {settable.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ margin: 0, flex: '1 1 110px' }}>
              {/* The label follows the direction toggle, so the box always
                  says what the number in it means. */}
              <label className="form-label">
                {form.invert
                  ? t('rates.perOne', { unit: form.currency || '', of: base })
                  : t('rates.perOne', { unit: base, of: form.currency || '' })}
              </label>
              <NumberInput className="form-control" step="any" min="0"
                value={form.rate}
                onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} />
            </div>
            <div className="form-group" style={{ margin: 0, width: 140 }}>
              <label className="form-label">{t('rates.effectiveFrom')}</label>
              <input type="date" className="form-control"
                value={form.effective_date}
                onChange={e => setForm(f => ({ ...f, effective_date: e.target.value }))} />
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6,
                          fontSize: 12, marginTop: 8 }}>
            <input type="checkbox" checked={form.invert}
              onChange={e => setForm(f => ({ ...f, invert: e.target.checked }))} />
            {t('rates.enterOtherWay', { unit: form.currency || '' })}
          </label>

          <input className="form-control" style={{ marginTop: 8, fontSize: 12 }}
            placeholder={t('rates.notePlaceholder')} value={form.note}
            onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />

          <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                        marginTop: 10 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? t('common.saving') : t('rates.save')}
            </button>
            <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
              {t('rates.historyHint')}
            </span>
          </div>
        </form>
      )}

      {book?.history?.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.5px',
                        textTransform: 'uppercase', color: 'var(--text-3)',
                        marginBottom: 6 }}>
            {t('rates.recentChanges')}
          </div>
          {book.history.slice(0, 6).map(h => (
            <div key={h.id} style={{ display: 'flex', gap: 8, fontSize: 11.5,
                                     color: 'var(--text-2)', padding: '2px 0' }}>
              <span style={{ minWidth: 72, color: 'var(--text-3)' }}>
                {fmtDate(h.effective_date || h.created_at)}
              </span>
              <span style={{ fontWeight: 600 }}>
                1 {base} = {fmtRate(h.rate)} {h.currency}
              </span>
              <span style={{ color: 'var(--text-3)', overflow: 'hidden',
                             textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {h.set_by_name}{h.note ? ` — ${h.note}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// The top-bar trigger: the pill everyone reads, and the popover the panel
// opens into.
export default function RateBook() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [book, setBook] = useState(null);
  const wrapRef = useRef(null);

  const load = useCallback(() => {
    getExchangeRate().then(setBook).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (open) load(); }, [open, load]);
  useScrollLock(open);

  useEffect(() => {
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const base = book?.base_currency || 'USD';
  const secondary = book?.secondary_currency || 'LBP';
  const rates = book?.rates || {};
  const foreign = Object.keys(rates);
  // The oldest rate in the book dates the whole thing: a fresh euro rate does
  // not make a three-week-old pound rate current.
  const oldest = foreign
    .map(c => ageInDays(rates[c].effective_date || rates[c].created_at))
    .filter(n => n != null)
    .reduce((a, b) => Math.max(a, b), 0);
  const stale = foreign.length > 0 && oldest >= STALE_DAYS;

  // The pill shows the rate people actually quote at each other.
  const headline = (book?.pairs || []).find(
    p => p.from === base && p.to === secondary);

  return (
    <div style={{ position: 'relative' }} ref={wrapRef}>
      <button
        className="btn btn-outline"
        onClick={() => setOpen(o => !o)}
        title={t('rates.title')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                 padding: '4px 10px', whiteSpace: 'nowrap' }}
      >
        <Icon name="refresh-cw" size={12} />
        {headline
          ? `1 ${base} = ${fmtRate(headline.rate)} ${secondary}`
          : t('rates.none')}
        {/* A rate nobody has touched in a week is not describing anything.
            Same threshold as the stale-rate notification, so the two agree. */}
        {stale && (
          <span style={{ width: 6, height: 6, borderRadius: '50%',
                         background: 'var(--yellow)' }} />
        )}
      </button>

      {open && (
        <div className="notif-dropdown" style={{ width: 380 }}>
          <div className="notif-dropdown-header">
            <span className="notif-dropdown-title">{t('rates.title')}</span>
            {stale && (
              <span style={{ fontSize: 11, color: 'var(--yellow)', fontWeight: 600 }}>
                {t('rates.staleDays', { n: oldest })}
              </span>
            )}
          </div>
          <div className="notif-dropdown-scroll" style={{ padding: 0 }}>
            <RateBookPanel onClose={() => load()} />
          </div>
        </div>
      )}
    </div>
  );
}
