import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { EmptyState, DisplayCurrencyToggle } from '../components/shared';
import { getBoms, getManufacturingProducts, getManufacturingSummary } from '../api/client';

// Modals + tab views + shared ui/constants extracted into ./manufacturing/ —
// this file is the orchestrator (tab switch + shared summary/products state).
import { Money } from './manufacturing/ui';
import { OrdersView } from './manufacturing/OrdersView';
import { BomsView } from './manufacturing/BomsView';
import { AnalyticsView } from './manufacturing/AnalyticsView';
import { QCView } from './manufacturing/QCView';
import { ResourcesView } from './manufacturing/ResourcesView';

export default function Manufacturing() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [view, setView] = useState('orders');
  const [products, setProducts] = useState([]);
  const [boms, setBoms] = useState([]);
  const [summary, setSummary] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const canView   = can('manufacturing', 'view');
  const canCreate = can('manufacturing', 'create');
  const canEdit   = can('manufacturing', 'edit');
  const canDelete = can('manufacturing', 'delete');

  const reloadRefs = useCallback(() => {
    getManufacturingProducts().then(setProducts).catch(() => {});
    getBoms().then(setBoms).catch(() => {});
    getManufacturingSummary().then(setSummary).catch(() => {});
  }, []);
  useEffect(() => { reloadRefs(); }, [reloadRefs]);

  const bump = () => { setRefreshKey(k => k + 1); reloadRefs(); };

  const tabs = [
    { key: 'orders', label: t('manufacturing.tabOrders') },
    { key: 'boms',   label: t('manufacturing.tabBoms') },
    { key: 'qc',     label: t('manufacturing.tabQC') },
    { key: 'resources', label: t('manufacturing.tabResources') },
    { key: 'analytics', label: t('manufacturing.tabAnalytics') },
  ];

  if (!canView) return <EmptyState message={t('manufacturing.subtitle')} icon="🔒" />;

  const kpis = summary ? [
    { label: t('manufacturing.kpiBoms'),       value: summary.boms },
    { label: t('manufacturing.st_Draft'),      value: summary.draft },
    { label: t('manufacturing.st_Confirmed'),  value: summary.confirmed },
    { label: t('manufacturing.st_InProgress'), value: summary.in_progress },
    { label: t('manufacturing.kpiReserved'),   value: summary.reserved_value, money: true },
    { label: t('manufacturing.kpiCompletedValue'), value: summary.completed_value, money: true },
  ] : [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>{t('manufacturing.title')}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <DisplayCurrencyToggle />
          <div style={{ display: 'flex', gap: 4 }}>
            {tabs.map(tb => (
              <button key={tb.key}
                className={`btn btn-sm ${view === tb.key ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setView(tb.key)}>
                {tb.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p style={{ color: 'var(--text-3)', fontSize: 13, margin: '0 0 16px' }}>{t('manufacturing.subtitle')}</p>

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 10, marginBottom: 18 }}>
          {kpis.map(k => (
            <div key={k.label} className="stat-card" style={{ padding: '12px 14px' }}>
              <div className="stat-label" style={{ fontSize: 11 }}>{k.label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
                {k.money ? <Money value={k.value} /> : k.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'orders' && (
        <OrdersView canCreate={canCreate} canEdit={canEdit} canDelete={canDelete}
          boms={boms} refreshKey={refreshKey} bump={bump} />
      )}
      {view === 'boms' && (
        <BomsView canCreate={canCreate} canEdit={canEdit} canDelete={canDelete}
          products={products} refreshKey={refreshKey} bump={bump} />
      )}
      {view === 'qc' && (
        <QCView canEdit={canEdit} bump={bump} />
      )}
      {view === 'resources' && (
        <ResourcesView canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />
      )}
      {view === 'analytics' && <AnalyticsView />}
    </div>
  );
}
