// Accounting — double-entry general ledger.
//
// Eight tabs, each with the controls operators expect from a real accounting
// suite:
//
//   • Overview         — KPIs + balance-sheet check, with a date-range
//                        selector (presets + custom) so the cards adapt to
//                        whichever window the operator is reviewing.
//   • Accounts         — Chart of Accounts with type filter, active/inactive
//                        toggle, free-text search, sortable columns and
//                        client-side pagination.
//   • Journal          — Server-paged with date range, status filter,
//                        source-type filter, text search and sortable
//                        columns. Pagination uses the backend's
//                        total/limit/offset contract.
//   • Ledger           — Account + range, sortable transactions and a
//                        client-side page navigator for high-volume accounts.
//   • Trial Balance    — Type filter + free-text search + sortable columns;
//                        the footer total stays in sync with the filter.
//   • Income Statement — Range only (small table, no pagination needed).
//   • Balance Sheet    — As-of date (small table).
//   • Closing          — YearEnd (small) + MonthlyPeriods with year + status
//                        filter so an operator looking at "2026, still open"
//                        gets one click to the rows that matter.


import { useState } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';

// Each tab lives in ./accounting/ — this file is the orchestrator
// (tab bar + permission wiring).
import { Overview } from './accounting/Overview';
import { Accounts } from './accounting/Accounts';
import { Journal } from './accounting/Journal';
import { Ledger } from './accounting/Ledger';
import { TrialBalance } from './accounting/TrialBalance';
import { IncomeStatement, BalanceSheet } from './accounting/Statements';
import { CashFlow } from './accounting/CashFlow';
import { YearEnd, MonthlyPeriods } from './accounting/Closing';

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
    ['cashFlow', t('accounting.cashFlow')],
    ['closing', t('accounting.closing')],
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

      {tab === 'overview' && <Overview t={t} fmt={fmt} fmtDate={fmtDate} />}
      {tab === 'accounts' && <Accounts t={t} canCreate={canCreate} canEdit={canEdit} can={can} />}
      {tab === 'journal' && <Journal t={t} fmt={fmt} fmtDate={fmtDate} canCreate={canCreate} canEdit={canEdit} />}
      {tab === 'ledger' && <Ledger t={t} fmt={fmt} fmtDate={fmtDate} />}
      {tab === 'trialBalance' && <TrialBalance t={t} fmt={fmt} />}
      {tab === 'incomeStatement' && <IncomeStatement t={t} fmt={fmt} />}
      {tab === 'balanceSheet' && <BalanceSheet t={t} fmt={fmt} />}
      {tab === 'cashFlow' && <CashFlow t={t} fmt={fmt} />}
      {tab === 'closing' && <>
        <YearEnd t={t} fmt={fmt} can={can} />
        <MonthlyPeriods t={t} fmt={fmt} can={can} />
      </>}
    </div>
  );
}
