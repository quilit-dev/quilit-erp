// Bank accounts — the ones money actually moves through.
//
// These are ledger accounts: each gets its own code in the chart when it is
// created, which is what makes a per-account balance possible and a statement
// reconcilable. The table and the API have existed since bank accounts were
// added; there was simply no screen, so nothing could be created and no
// payment could name one.
//
// There used to be a second thing called "bank" on this page — four free-text
// lines printed at the foot of an invoice, holding no balance and connected to
// nothing. It has been removed, so the word means one thing here now.
//
// Deleting is deliberately absent. An account is what historical entries point
// at, so one that has seen a movement is archived, never removed — the same
// rule the rest of the system follows for anything the ledger references.
import { useState, useEffect, useCallback } from 'react';
import { getBankAccounts, createBankAccount, updateBankAccount,
         archiveBankAccount } from '../../api/client';
import { toast, fmt, NumberInput, ConfirmModal } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Section, Field, Input, CURRENCIES } from './ui';
import SearchSelect from '../../components/SearchSelect.jsx';

const EMPTY = {
  name: '', bank_name: '', account_number: '', iban: '', swift: '',
  currency: 'USD', opening_balance: '', notes: '',
};

export function BankAccountsSection({ canEdit }) {
  const { t } = useLocale();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(() => {
    getBankAccounts().then(r => setRows(Array.isArray(r) ? r : []))
      .catch(() => setRows([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  function startNew() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function startEdit(row) {
    setEditing(row.id);
    setForm({
      name: row.name || '', bank_name: row.bank_name || '',
      account_number: row.account_number || '', iban: row.iban || '',
      swift: row.swift || '', currency: row.currency || 'USD',
      opening_balance: row.opening_balance ?? '', notes: row.notes || '',
    });
    setOpen(true);
  }

  async function save(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast(t('banks.needName'), 'red'); return; }
    setBusy(true);
    try {
      const body = {
        ...form,
        opening_balance: form.opening_balance === '' ? 0
          : Number(form.opening_balance),
      };
      if (editing) await updateBankAccount(editing, body);
      else await createBankAccount(body);
      toast(t('banks.saved'), 'green');
      setOpen(false); setForm(EMPTY); setEditing(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function archive(id) {
    setConfirming(null);
    try {
      await archiveBankAccount(id);
      toast(t('banks.archived'), 'green');
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  return (
    <Section title={t('banks.title')} icon="landmark">
      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 14px' }}>
        {t('banks.desc')}
      </p>

      {rows.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('banks.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('banks.name')}</th>
                <th>{t('banks.bankName')}</th>
                <th>{t('banks.accountNumber')}</th>
                <th>{t('common.currency')}</th>
                {/* The code it posts to, so an accountant can find it in the
                    chart without guessing. */}
                <th>{t('banks.glCode')}</th>
                <th className="text-right">{t('banks.balance')}</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ opacity: r.archived_at ? 0.5 : 1 }}>
                  <td className="td-primary">{r.name}</td>
                  <td>{r.bank_name || '—'}</td>
                  <td className="text-mono">{r.account_number || r.iban || '—'}</td>
                  <td>{r.currency}</td>
                  <td className="text-mono">{r.account_code || '—'}</td>
                  <td className="text-right">{fmt(r.balance)}</td>
                  {canEdit && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-secondary"
                        onClick={() => startEdit(r)}>{t('common.edit')}</button>
                      {!r.archived_at && (
                        <button className="btn btn-sm btn-ghost"
                          style={{ marginInlineStart: 6 }}
                          onClick={() => setConfirming(r)}>
                          {t('common.archive')}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && !open && (
        <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }}
          onClick={startNew}>{t('banks.add')}</button>
      )}

      {canEdit && open && (
        <form onSubmit={save} style={{ marginTop: 14, paddingTop: 14,
                                       borderTop: '1px solid var(--border)' }}>
          <div className="form-grid">
            <Field label={t('banks.name')} hint={t('banks.nameHint')}>
              <Input value={form.name}
                onChange={v => setForm(f => ({ ...f, name: v }))} />
            </Field>
            <Field label={t('banks.bankName')}>
              <Input value={form.bank_name}
                onChange={v => setForm(f => ({ ...f, bank_name: v }))} />
            </Field>
            <Field label={t('banks.accountNumber')}>
              <Input value={form.account_number}
                onChange={v => setForm(f => ({ ...f, account_number: v }))} />
            </Field>
            <Field label={t('banks.iban')}>
              <Input value={form.iban}
                onChange={v => setForm(f => ({ ...f, iban: v }))} />
            </Field>
            <Field label={t('banks.swift')}>
              <Input value={form.swift}
                onChange={v => setForm(f => ({ ...f, swift: v }))} />
            </Field>
            <div className="form-group">
              <label className="form-label">{t('common.currency')}</label>
              <SearchSelect
                className="form-control"
                disabled={!!editing}
                value={form.currency}
                onChange={v => setForm(f => ({ ...f, currency: v }))}
                options={(CURRENCIES).map(c => ({ value: c, label: c }))} />
            </div>
            <div className="form-group">
              {/* What the account held before the ERP started keeping it, so
                  the balance here can be compared with a statement from day
                  one rather than from the first payment recorded. */}
              <label className="form-label">{t('banks.openingBalance')}</label>
              <NumberInput className="form-control" step="any"
                value={form.opening_balance}
                onChange={e => setForm(f => ({ ...f, opening_balance: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
            <button type="button" className="btn btn-secondary"
              onClick={() => { setOpen(false); setEditing(null); }}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {confirming && (
        <ConfirmModal
          title={t('common.archive')}
          message={t('banks.archiveConfirm', { name: confirming.name })}
          onConfirm={() => archive(confirming.id)}
          onCancel={() => setConfirming(null)} />
      )}
    </Section>
  );
}
