/**
 * Warehouses — multi-location stock administration.
 *
 * Three tabs in one page so the operator doesn't have to navigate between
 * separate screens:
 *
 *   1. Warehouses — list/create/edit + Set Default + archive.
 *   2. Transfers — stock movements between warehouses (Draft → In Transit →
 *      Completed) with the full audit trail.
 *   3. Access  — who can transact in each warehouse (admin-only).
 *
 * All UI strings flow through useLocale → t('warehouses.*') so the page
 * mirrors correctly in both English and Arabic (RTL).
 */
import { useState } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';

// Each tab lives in ./warehouses/ — this file is the orchestrator.
import { WarehousesTab } from './warehouses/WarehousesTab';
import { TransfersTab } from './warehouses/TransfersTab';
import { AccessTab } from './warehouses/AccessTab';

export default function Warehouses() {
  const { t } = useLocale();
  const { can, isSuperadmin } = usePermissions();
  const [tab, setTab] = useState('warehouses');

  const canEdit = isSuperadmin || can('warehouses', 'edit') || can('warehouses', 'create');
  // Stock transfers are an INVENTORY operation (backend gates them on the
  // `inventory` permission), so a Branch Manager — full inventory, view-only
  // warehouses — can run them while still being unable to create branches.
  const canTransfer = isSuperadmin || can('inventory', 'edit') || can('inventory', 'create');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('warehouses.title')}</h1>
          <p className="page-subtitle">{t('warehouses.subtitle')}</p>
        </div>
      </div>

      {/* Use the shared .tabs / .tab-btn pattern so the typography matches
          every other page (Accounting, ProjectDetail, etc.). The earlier
          inline-styled version was a few pixels heavier and looked off. */}
      <div className="tabs">
        {[
          { key: 'warehouses', label: t('warehouses.tabWarehouses') },
          { key: 'transfers',  label: t('warehouses.tabTransfers')  },
          { key: 'access',     label: t('warehouses.tabAccess')     },
        ].map(it => (
          <button key={it.key}
            className={`tab-btn${tab === it.key ? ' active' : ''}`}
            onClick={() => setTab(it.key)}>
            {it.label}
          </button>
        ))}
      </div>

      {tab === 'warehouses' && <WarehousesTab canEdit={canEdit} t={t} />}
      {tab === 'transfers'  && <TransfersTab  canEdit={canTransfer} t={t} />}
      {tab === 'access'     && <AccessTab t={t} />}
    </div>
  );
}
