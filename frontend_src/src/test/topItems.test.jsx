// Top selling items report: a tab on Reports, sortable, exportable, and it
// only shows cost columns when the server says the user may see cost.
import { describe, test, expect } from 'vitest';
import reportSrc from '../pages/reports/TopItemsReport.jsx?raw';
import reportsSrc from '../pages/Reports.jsx?raw';
import clientSrc from '../api/client.js?raw';
import en from '../locales/en.js';
import ar from '../locales/ar.js';

describe('the top selling items report', () => {
  test('is a tab on the Reports page, fed by its own endpoint', () => {
    expect(reportsSrc).toContain("{ key: 'topItems',");
    expect(reportsSrc).toContain("current === 'topItems'  && <TopItemsReport");
    expect(clientSrc).toContain('/api/reports/top-items');
  });

  test('sorts by quantity, sales, and profit only for users who may see cost', () => {
    expect(reportSrc).toContain("['quantity', t('reports.topByQuantity')]");
    expect(reportSrc).toContain("['revenue',  t('reports.topBySales')]");
    expect(reportSrc).toContain("...(cost ? [['profit', t('reports.topByProfit')]] : [])");
  });

  test('cost columns follow show_cost, and it exports', () => {
    expect(reportSrc).toContain('const cost = data.show_cost;');
    expect(reportSrc).toContain('<ExportButtons');
    expect(reportSrc).toContain("t('reports.notSold')");
  });

  test('every string exists in both languages', () => {
    for (const k of ['topItems', 'topByQuantity', 'topBySales', 'topByProfit', 'qtySold',
                     'netSales', 'notSold', 'costEstimatedHint', 'lastSold', 'neverSold']) {
      expect(en.reports[k], k).toBeTruthy();
      expect(ar.reports[k], k).toBeTruthy();
      expect(ar.reports[k]).not.toBe(en.reports[k]);
    }
  });
});
