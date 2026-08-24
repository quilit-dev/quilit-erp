// Housekeeping batch: opt-in recurring spreading, exports where they were
// missing, and the Inventory-by-Attribute report gone for good.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en';
import ar from '../locales/ar';
import recurringSrc from '../components/RecurringExpensesPanel.jsx?raw';
import serviceSrc from '../pages/Service.jsx?raw';
import branchSrc from '../pages/reports/BranchComparisonReport.jsx?raw';
import warehouseSrc from '../pages/reports/WarehouseValuationReport.jsx?raw';
import reportsSrc from '../pages/Reports.jsx?raw';
import apiSrc from '../api/client.js?raw';

const here = path.dirname(fileURLToPath(import.meta.url));
const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('spreading a recurring cost is a choice', () => {
  test('the form carries the flag, off by default', () => {
    expect(recurringSrc).toMatch(/spread_across_period: false/);
  });

  test('editing an existing template loads its setting', () => {
    // Without this the toggle silently resets to off on every edit, and
    // saving would turn spreading off for a template that had it on.
    expect(recurringSrc).toMatch(/spread_across_period: !!tpl\.spread_across_period/);
  });

  test('the toggle only appears where it can change anything', () => {
    // The backend spreads over the months the period covers — one, for
    // weekly and monthly. Offering the choice there would be a lie.
    expect(recurringSrc).toMatch(/\['quarterly', 'annual'\]\.includes\(form\.frequency\)/);
  });

  test('it says what each setting does', () => {
    expect(recurringSrc).toMatch(/spreadOnHint/);
    expect(recurringSrc).toMatch(/spreadOffHint/);
  });
});

describe('exports reach the screens that lacked them', () => {
  test('service jobs and equipment both export', () => {
    expect(serviceSrc).toMatch(/filename="ServiceJobs"/);
    expect(serviceSrc).toMatch(/filename="ServiceEquipment"/);
  });

  test('the service export carries what the filters left', () => {
    // Both lists are filtered server-side, so exporting the rows on screen
    // is exactly the filtered set — not the whole table.
    expect(serviceSrc).toMatch(/\(jobs\.data \|\| \[\]\)\.map/);
    expect(serviceSrc).toMatch(/\(equipment\.data \|\| \[\]\)\.map/);
  });

  test('branch comparison exports, totals included', () => {
    expect(branchSrc).toMatch(/<ExportButtons/);
    expect(branchSrc).toMatch(/label: t\('reports\.total'\)/);
  });

  test('warehouse valuation gains PDF beside its workbook', () => {
    expect(warehouseSrc).toMatch(/exportReportPDF/);
    expect(warehouseSrc).toMatch(/exportXlsx/);   // the two-sheet one survives
  });

  test('totals are shaped the way exportReportPDF reads them', () => {
    // It indexes `totals.columns[i]` by column position and substitutes the
    // label at 0. A bare array renders the label twice and shifts every cell.
    for (const [src, name] of [[branchSrc, 'branch'], [warehouseSrc, 'warehouse']]) {
      expect(src, name).toMatch(/label:.*\n?\s*columns: \[null/);
    }
  });

  test('every list and report screen exports something', () => {
    const dirs = [path.resolve(here, '../pages'), path.resolve(here, '../pages/reports')];
    const missing = [];
    for (const dir of dirs) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsx') || f === 'charts.jsx' || f === 'Reports.jsx') continue;
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        const isList = /<table/.test(src);
        if (isList && !/ExportButtons?|exportXlsx|exportReportPDF|XLSX\.writeFile/.test(src)) {
          missing.push(f);
        }
      }
    }
    // The exceptions, and why each one is not a dataset: configuration
    // screens, detail pages that export from their own tabs, and the
    // platform console. A new list screen appearing here is the point —
    // it means someone shipped a table nobody can get out of the system.
    expect(missing.sort()).toEqual([
      // ClientDetail left this list when its invoices tab gained an export.
      'ApprovalPolicies.jsx', 'ApprovalRequests.jsx',
      'Communications.jsx', 'Dashboard.jsx', 'Finance.jsx',
      'PlatformConsole.jsx', 'ProjectDetail.jsx', 'Promotions.jsx',
      'Recruitment.jsx', 'RoleManagement.jsx', 'UserManagement.jsx',
    ].sort());
  });
});

describe('Inventory by Attribute is gone, attributes are not', () => {
  test('nothing still reaches for the removed report', () => {
    expect(apiSrc).not.toMatch(/getInventoryByAttributeReport/);
    expect(reportsSrc).not.toMatch(/AttributeBreakdownReport/);
    expect(fs.existsSync(path.resolve(here, '../pages/reports/AttributeBreakdownReport.jsx')))
      .toBe(false);
  });

  test('no stale documentation was left behind describing it', () => {
    expect(warehouseSrc).not.toMatch(/Inventory by Attribute/);
  });
});

describe('translation', () => {
  test('the new keys resolve in both languages', () => {
    for (const k of ['recurring.fldRecognition', 'recurring.spreadLabel',
                     'recurring.spreadOnHint', 'recurring.spreadOffHint']) {
      expect(typeof lookup(en, k), k).toBe('string');
      expect(typeof lookup(ar, k), k).toBe('string');
    }
  });

  test('the Arabic is actually Arabic', () => {
    const latinOnly = ['fldRecognition', 'spreadLabel', 'spreadOnHint', 'spreadOffHint']
      .filter(k => /[A-Za-z]{3,}/.test(ar.recurring[k]) && !/[؀-ۿ]/.test(ar.recurring[k]));
    expect(latinOnly).toEqual([]);
  });

  test('every key the recurring panel uses resolves', () => {
    const keys = [...recurringSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });
});
