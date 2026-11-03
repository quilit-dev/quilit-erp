// The Service report lists each job, with its detail one click away.
import { describe, test, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { ServiceJobsDetail } from '../pages/reports/ServiceJobsDetail';
import reportSrc from '../pages/reports/ServiceReport.jsx?raw';
import en from '../locales/en.js';
import ar from '../locales/ar.js';

const t = (k) => k.split('.').reduce((o, p) => (o || {})[p], en) || k;
const JOB = {
  id: 7, job_number: 'SVC-2026-0007', job_type: 'Repair', status: 'Done',
  completed_at: '2026-10-20', client_name: 'Nour Bakery', equipment_name: 'Bakery oven',
  technicians: ['Rami', 'Hadi'], reported_fault: 'Fan seized', work_done: 'Replaced belt',
  revenue: 136, parts_cost: 12, margin: 124, margin_pct: 91.2, subtotal: 136,
  labour_total: 100, parts_total: 36, invoice_number: null, invoice_status: null,
  lines: [{ type: 'part', name: 'Belt', quantity: 3, unit_price: 12, net: 36, cost: 12 },
          { type: 'charge', name: 'Labour', quantity: 2, unit_price: 50, net: 100 }],
};
const mount = (props) => render(<LocaleProvider><ServiceJobsDetail jobs={[JOB]} t={t} {...props} /></LocaleProvider>);

describe('service jobs in the report', () => {
  test('each job is a row, and opening it shows the fault, the work and the lines', () => {
    localStorage.setItem('erp_lang', 'en');
    mount({ showCost: true });
    expect(screen.getByText('SVC-2026-0007')).toBeTruthy();
    expect(screen.getByText('Rami, Hadi')).toBeTruthy();
    expect(screen.queryByText('Replaced belt')).toBeNull();
    fireEvent.click(screen.getByText('SVC-2026-0007'));
    expect(screen.getByText('Fan seized')).toBeTruthy();
    expect(screen.getByText('Replaced belt')).toBeTruthy();
    expect(screen.getByText('Belt')).toBeTruthy();
    expect(screen.getByText('Labour')).toBeTruthy();
  });

  test('without cost permission there are no cost columns', () => {
    mount({ showCost: false });
    expect(screen.queryByText(en.service.partsCost)).toBeNull();
  });

  test('it sits under the technician table, and its strings exist in both languages', () => {
    expect(reportSrc).toContain('<ServiceJobsDetail jobs={data.jobs || []} showCost={!!data.show_cost}');
    for (const k of ['jobDetails', 'searchJobs', 'labourTotal', 'partsTotal', 'noLines', 'notConsumed']) {
      expect(en.service[k], k).toBeTruthy();
      expect(ar.service[k]).not.toBe(en.service[k]);
    }
  });
});
