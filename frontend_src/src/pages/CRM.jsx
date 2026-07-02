// CRM — leads, deals pipeline, contacts, activities.
//
// Each tab (and its form/modals) lives in ./crm/ — this file is the
// orchestrator (tab bar only).
import { useState } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';

import { DashboardTab } from './crm/DashboardTab';
import { LeadsTab } from './crm/LeadsTab';
import { ContactsTab } from './crm/ContactsTab';
import { ActivitiesTab } from './crm/ActivitiesTab';
import { PipelineTab } from './crm/PipelineTab';

// ─── Main CRM Page ────────────────────────────────────────────────────────────

const TABS = [
  { key: 'dashboard',  labelKey: 'crm.dashboard'  },
  { key: 'pipeline',   labelKey: 'crm.deals'       },
  { key: 'leads',      labelKey: 'crm.leads'       },
  { key: 'contacts',   labelKey: 'crm.contacts'    },
  { key: 'activities', labelKey: 'crm.activities'  },
];

export default function CRM() {
  const { t } = useLocale();
  const [activeTab, setActiveTab] = useState('dashboard');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('crm.pageTitle')}</h1>
          <p className="page-subtitle">{t('crm.subtitle')}</p>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(tab => (
          <button key={tab.key}
            className={`tab-btn${activeTab === tab.key ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.key)}>
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 20 }}>
        {activeTab === 'dashboard'  && <DashboardTab  t={t} />}
        {activeTab === 'pipeline'   && <PipelineTab   t={t} />}
        {activeTab === 'leads'      && <LeadsTab       t={t} />}
        {activeTab === 'contacts'   && <ContactsTab    t={t} />}
        {activeTab === 'activities' && <ActivitiesTab  t={t} />}
      </div>
    </div>
  );
}
