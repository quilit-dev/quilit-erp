import { useState, useEffect } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import { useLocale } from '../hooks/useLocale.jsx';
import { getBranchContext } from '../api/client';

// Charts/helpers + each report extracted into ./reports/ — this file is the
// orchestrator (report picker + date range + branch context).
import { DateRangeBar, getRange } from './reports/charts';
import { FinancialReport } from './reports/FinancialReport';
import { VatReport } from './reports/VatReport';
import { ProjectsReport } from './reports/ProjectsReport';
import { ClientsReport } from './reports/ClientsReport';
import { AgingReport } from './reports/AgingReport';
import { ExpensesReport } from './reports/ExpensesReport';
import { PipelineReport } from './reports/PipelineReport';
import { BranchComparisonReport } from './reports/BranchComparisonReport';
import { WarehouseValuationReport } from './reports/WarehouseValuationReport';

export default function Reports() {
  const { t } = useLocale();
  const [activeReport, setActiveReport] = usePersistedState('reports_active', 'financial');
  // Branch comparison tab appears only for global users (superadmin / owner)
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
    end:   new Date().toISOString().slice(0, 10),
  });
  const [appliedRange, setAppliedRange] = useState(getRange(preset, custom));

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

  const REPORTS = [
    { key: 'financial',   label: t('reports.financial')      },
    { key: 'projects',    label: t('reports.projects')       },
    { key: 'clients',     label: t('reports.clients')        },
    { key: 'aging',       label: t('reports.aging')          },
    { key: 'expenses',    label: t('reports.expensesReport') },
    { key: 'pipeline',    label: t('reports.pipeline')       },
    { key: 'vat',         label: t('reports.vat')            },
    { key: 'whValuation', label: t('reports.whValuation') || 'Inventory by Warehouse' },
    ...(multiBranch ? [{ key: 'branches', label: t('reports.branchComparison') }] : []),
  ];

  return (
    <div>
      {/* Page header */}
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title">{t('reports.title')}</h1>
          <p className="page-subtitle">{t('reports.subtitle')}</p>
        </div>
      </div>

      {/* Date range bar */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ padding: '12px 20px' }}>
          <DateRangeBar
            preset={preset} custom={custom}
            onPreset={handlePreset} onCustom={setCustom}
            onApply={handleApply} t={t}
          />
        </div>
      </div>

      {/* Tabs — wrap so all report tabs fit the page instead of scrolling
          horizontally off-screen (there are up to 10, with long labels). */}
      <div className="tabs" style={{ flexWrap: 'wrap', overflowX: 'visible' }}>
        {REPORTS.map(r => (
          <button
            key={r.key}
            className={`tab-btn${activeReport === r.key ? ' active' : ''}`}
            onClick={() => setActiveReport(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Report content — full width */}
      {activeReport === 'financial' && <FinancialReport params={appliedRange} t={t} />}
      {activeReport === 'projects'  && <ProjectsReport  params={appliedRange} t={t} />}
      {activeReport === 'clients'   && <ClientsReport   params={appliedRange} t={t} />}
      {activeReport === 'aging'     && <AgingReport      t={t} />}
      {activeReport === 'expenses'  && <ExpensesReport   params={appliedRange} t={t} />}
      {activeReport === 'pipeline'  && <PipelineReport   params={appliedRange} t={t} />}
      {activeReport === 'vat'       && <VatReport        params={appliedRange} t={t} />}
      {activeReport === 'whValuation' && <WarehouseValuationReport t={t} />}
      {activeReport === 'branches'  && <BranchComparisonReport params={appliedRange} t={t} />}
    </div>
  );
}
