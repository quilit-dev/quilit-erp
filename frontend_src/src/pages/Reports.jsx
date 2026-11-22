import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePersistedState } from '../hooks/usePersistedState';
import { useLocale } from '../hooks/useLocale.jsx';
import { getBranchContext } from '../api/client';
import { usePermissions } from '../hooks/usePermissions';
import { fmtDate } from '../components/shared';
import SearchSelect from '../components/SearchSelect';

// Charts/helpers + each report extracted into ./reports/ — this file is the
// orchestrator: which report, which period, and the navigation between them.
import { DateRangeBar, getRange } from './reports/charts';
import { VatReport } from './reports/VatReport';
import { ProjectsReport } from './reports/ProjectsReport';
import { ClientsReport } from './reports/ClientsReport';
import { AgingReport } from './reports/AgingReport';
import { PaymentPlansReport } from './reports/PaymentPlansReport';
import { ExpensesReport } from './reports/ExpensesReport';
import { PipelineReport } from './reports/PipelineReport';
import { BranchComparisonReport } from './reports/BranchComparisonReport';
import { WarehouseValuationReport } from './reports/WarehouseValuationReport';
import { ServiceReport } from './reports/ServiceReport';
import { ProfitSummaryReport } from './reports/ProfitSummaryReport';
import { TopItemsReport } from './reports/TopItemsReport';
import { ItemLedgerReport } from './reports/ItemLedgerReport';

// The reports, grouped by the question they answer rather than listed as one
// long strip of tabs (thirteen tabs wrapped onto two rows, which nobody can
// scan). `dated` is whether the report reads the period: the date controls
// show only where they do something.
const GROUPS = [
  { key: 'overview',    reports: [{ key: 'profit', dated: false }] },
  { key: 'sales',       reports: [{ key: 'clients', dated: true }, { key: 'topItems', dated: true },
                                  { key: 'pipeline', dated: true }] },
  { key: 'receivables', reports: [{ key: 'aging', dated: true }, { key: 'plans', dated: true }] },
  { key: 'inventory',   reports: [{ key: 'whValuation', dated: false }, { key: 'itemLedger', dated: true }] },
  { key: 'costs',       reports: [{ key: 'expenses', dated: true }, { key: 'projects', dated: true },
                                  { key: 'service', dated: true }] },
  { key: 'tax',         reports: [{ key: 'vat', dated: true }] },
  { key: 'company',     reports: [{ key: 'branches', dated: true }] },
];

// Report key → its label key (kept from the tab days, so translations stand).
const LABEL = {
  profit: 'reports.profitSummary', clients: 'reports.clients', topItems: 'reports.topItems',
  pipeline: 'reports.pipeline', aging: 'reports.aging', plans: 'reports.pp.title',
  whValuation: 'reports.whValuation', itemLedger: 'reports.itemLedger', expenses: 'reports.expensesReport',
  projects: 'reports.projects', service: 'reports.service', vat: 'reports.vat',
  branches: 'reports.branchComparison',
};

// Whether the report list is open beside the report. A per-person preference
// kept on this device; with none yet, a laptop screen starts with it folded so
// the report gets the width, and a large monitor starts with it open.
const NAV_KEY = 'reports_nav_open';
function initialNavOpen() {
  try {
    const v = localStorage.getItem(NAV_KEY);
    if (v === '1' || v === '0') return v === '1';
  } catch { /* storage unavailable: fall through to the screen-size default */ }
  return typeof window === 'undefined' || window.innerWidth >= 1440;
}

const PanelIcon = ({ open }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
    {open ? <polyline points="15 10 13 12 15 14" /> : <polyline points="13 10 15 12 13 14" />}
  </svg>
);

export default function Reports() {
  const { t, tEnumValue } = useLocale();
  // The Profit Summary has its own permission: Reports access alone does not
  // show a company's margin and net profit.
  const { can } = usePermissions();
  const canProfit = can('profit_report');
  const [activeReport, setActiveReport] = usePersistedState('reports_active', 'profit');
  // Each report has its own address (?report=aging), so a report can be
  // linked to, bookmarked, and reached with the browser's Back button. An
  // inventory row's Ledger button sends ?report=itemLedger&item=<id>.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedReport = searchParams.get('report');
  const linkedItem = searchParams.get('item');
  useEffect(() => { if (linkedReport) setActiveReport(linkedReport); }, [linkedReport]);
  // Branch comparison appears only for global users (superadmin / owner)
  // who can actually see more than one branch.
  const [multiBranch, setMultiBranch] = useState(false);
  useEffect(() => {
    let alive = true;
    getBranchContext()
      .then(d => { if (alive) setMultiBranch(!!(d && d.is_global) && ((d && d.branches) || []).length > 1); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const [preset, setPreset]             = usePersistedState('reports_preset', 'year');
  const [custom, setCustom]             = usePersistedState('reports_custom', {
    start: `${new Date().getFullYear()}-01-01`,
    end:   new Date().toLocaleDateString('en-CA'),   // local today, YYYY-MM-DD
  });
  const [appliedRange, setAppliedRange] = useState(getRange(preset, custom));
  const [find, setFind] = useState('');
  const [navOpen, setNavOpenState] = useState(initialNavOpen);
  function setNavOpen(v) {
    setNavOpenState(v);
    try { localStorage.setItem(NAV_KEY, v ? '1' : '0'); } catch { /* keep it for this visit only */ }
  }

  useEffect(() => {
    if (preset !== 'custom') {
      setAppliedRange(getRange(preset, custom));
    }
  }, [preset]);

  function handlePreset(p) {
    setPreset(p);
    if (p !== 'custom') setAppliedRange(getRange(p, custom));
  }

  function handleApply() {
    setAppliedRange(getRange('custom', custom));
  }

  // Every report that exists. `branches` is hidden below for users who cannot
  // see more than one branch, but stays in THIS list so a stored or linked
  // 'branches' is still recognised while the branch context is loading —
  // otherwise the page would flash another report, and fire its request,
  // before settling on the right one. The Profit Summary is left out entirely
  // for those not allowed to see it, so nothing can land on it.
  const ALL_REPORTS = useMemo(() => GROUPS.flatMap(g => g.reports
    .filter(r => r.key !== 'profit' || canProfit)
    .map(r => ({ ...r, group: g.key, label: t(LABEL[r.key]), desc: t(`reports.desc.${r.key}`) }))),
  [canProfit, t]);
  const REPORTS = ALL_REPORTS.filter(r => r.key !== 'branches' || multiBranch);

  // A remembered report can outlive the report itself; an unknown id falls
  // back to the first real one rather than a blank page.
  const current = ALL_REPORTS.some(r => r.key === activeReport)
    ? activeReport
    : ALL_REPORTS[0].key;
  const meta = ALL_REPORTS.find(r => r.key === current);

  function open(key) {
    setActiveReport(key);
    const next = new URLSearchParams(searchParams);
    next.set('report', key);
    if (key !== 'itemLedger') next.delete('item');
    setSearchParams(next, { replace: false });
  }

  const q = find.trim().toLowerCase();
  const visible = q
    ? REPORTS.filter(r => `${r.label} ${r.desc}`.toLowerCase().includes(q))
    : REPORTS;
  const groups = GROUPS
    .map(g => ({ key: g.key, items: visible.filter(r => r.group === g.key) }))
    .filter(g => g.items.length);

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title">{t('reports.title')}</h1>
          <p className="page-subtitle">{t('reports.subtitle')}</p>
        </div>
      </div>

      <div className={`reports-layout${navOpen ? '' : ' nav-collapsed'}`}>
        {/* ── The navigator: every report, grouped, searchable. Folds into a
            thin rail so the report can take the whole width. ─────────── */}
        {!navOpen && (
          <button type="button" className="report-nav-rail" onClick={() => setNavOpen(true)}
            aria-expanded="false" aria-controls="report-nav" title={t('reports.showList')}>
            <PanelIcon open={false} />
            <span className="report-nav-rail-label">{t('reports.navLabel')}</span>
          </button>
        )}
        <aside id="report-nav" className="report-nav card" aria-label={t('reports.navLabel')} hidden={!navOpen}>
          <div className="report-nav-top">
            <input type="search" className="form-control report-nav-find" value={find}
              onChange={e => setFind(e.target.value)}
              placeholder={t('reports.findReport')} aria-label={t('reports.findReport')} />
            <button type="button" className="icon-btn report-nav-collapse" onClick={() => setNavOpen(false)}
              aria-expanded="true" aria-controls="report-nav"
              aria-label={t('reports.hideList')} title={t('reports.hideList')}>
              <PanelIcon open />
            </button>
          </div>
          <nav className="report-nav-list">
            {groups.map(g => (
              <div key={g.key} className="report-nav-group" role="group"
                   aria-labelledby={`rg-${g.key}`}>
                <div id={`rg-${g.key}`} className="report-nav-heading">{t(`reports.group.${g.key}`)}</div>
                {g.items.map(r => (
                  <button key={r.key} type="button"
                    className={`report-nav-item${r.key === current ? ' active' : ''}`}
                    aria-current={r.key === current ? 'page' : undefined}
                    title={r.desc}
                    onClick={() => open(r.key)}>
                    {r.label}
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <div className="report-nav-empty">{t('reports.noReportFound')}</div>}
          </nav>
        </aside>

        {/* On a phone the navigator is one searchable picker, each report
            carrying its group as a hint. */}
        <div className="report-picker">
          <span className="report-nav-heading">{t('reports.navLabel')}</span>
          <SearchSelect value={current} onChange={v => v && open(v)} searchable
            aria-label={t('reports.navLabel')} emptyText={t('reports.noReportFound')}
            options={REPORTS.map(r => ({ value: r.key, label: r.label,
                                         hint: t(`reports.group.${r.group}`) }))} />
        </div>

        {/* ── The report itself ───────────────────────────────────────── */}
        <section className="report-main" aria-labelledby="report-title">
          <div className="report-head">
            <div style={{ minWidth: 0 }}>
              {!navOpen && (
                <button type="button" className="btn btn-sm btn-secondary report-show-list"
                  onClick={() => setNavOpen(true)} aria-controls="report-nav" aria-expanded="false">
                  <PanelIcon open={false} /> {t('reports.allReports')}
                </button>
              )}
              <div className="report-eyebrow">{t(`reports.group.${meta.group}`)}</div>
              <h2 id="report-title" className="report-title">{meta.label}</h2>
              <p className="report-desc">{meta.desc}</p>
            </div>
            {/* The period, only where the report reads it — a date control
                that changes nothing is worse than none. */}
            {meta.dated && (
              <div className="report-period">
                <DateRangeBar
                  preset={preset} custom={custom}
                  onPreset={handlePreset} onCustom={setCustom}
                  onApply={handleApply} t={t}
                />
                <div className="report-period-shown">
                  {fmtDate(appliedRange.start)} – {fmtDate(appliedRange.end)}
                </div>
              </div>
            )}
          </div>

          {current === 'profit' && canProfit && <ProfitSummaryReport t={t} />}
          {current === 'topItems'  && <TopItemsReport  params={appliedRange} t={t} />}
          {current === 'itemLedger' && <ItemLedgerReport params={appliedRange} t={t} initialItem={linkedItem} />}
          {current === 'projects'  && <ProjectsReport  params={appliedRange} t={t} />}
          {current === 'clients'   && <ClientsReport   params={appliedRange} t={t} tEnumValue={tEnumValue} />}
          {current === 'aging'     && <AgingReport      params={appliedRange} t={t} />}
          {current === 'plans'     && <PaymentPlansReport params={appliedRange} t={t} />}
          {current === 'expenses'  && <ExpensesReport   params={appliedRange} t={t} />}
          {current === 'pipeline'  && <PipelineReport   params={appliedRange} t={t} />}
          {current === 'vat'       && <VatReport        params={appliedRange} t={t} />}
          {current === 'whValuation' && <WarehouseValuationReport t={t} />}
          {current === 'service'   && <ServiceReport   params={appliedRange} t={t} />}
          {current === 'branches'  && <BranchComparisonReport params={appliedRange} t={t} />}
        </section>
      </div>
    </div>
  );
}
