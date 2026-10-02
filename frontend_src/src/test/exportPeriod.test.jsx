// Exporting a period: last month, this year, or a from-to.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { exportPeriodRange, inExportRange, ExportButton } from '../components/shared';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import quotationsSrc from '../pages/Quotations.jsx?raw';
import expensesSrc from '../pages/Expenses.jsx?raw';
import purchasesSrc from '../pages/Purchases.jsx?raw';
import posSrc from '../pages/pos/HistoryView.jsx?raw';

const writeFile = vi.fn();
vi.mock('xlsx', () => ({
  utils: { json_to_sheet: r => r, book_new: () => ({}), book_append_sheet: () => {} },
  writeFile: (...a) => writeFile(...a),
}));

describe('the period arithmetic', () => {
  const mid = new Date(2026, 9, 15);           // 15 Oct 2026, local time
  test('months and years, by the local calendar', () => {
    expect(exportPeriodRange('this_month', {}, mid)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(exportPeriodRange('last_month', {}, mid)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(exportPeriodRange('this_year', {}, mid)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(exportPeriodRange('last_year', {}, mid)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(exportPeriodRange('all', {}, mid)).toBeNull();
  });
  test('last month in January is December of the year before', () => {
    expect(exportPeriodRange('last_month', {}, new Date(2026, 0, 5)))
      .toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
  test('February ends where it ends, leap years included', () => {
    expect(exportPeriodRange('last_month', {}, new Date(2028, 2, 1)).to).toBe('2028-02-29');
    expect(exportPeriodRange('last_month', {}, new Date(2026, 2, 1)).to).toBe('2026-02-28');
  });
  test('the first of the month just after midnight is still the first', () => {
    // toISOString() would say the 30th of September in Beirut at 01:00.
    expect(exportPeriodRange('this_month', {}, new Date(2026, 9, 1, 1, 0)).from).toBe('2026-10-01');
  });
  test('a custom range, and an empty one meaning all dates', () => {
    expect(exportPeriodRange('custom', { from: '2026-03-01', to: '2026-03-10' }))
      .toEqual({ from: '2026-03-01', to: '2026-03-10' });
    expect(exportPeriodRange('custom', { from: '', to: '' })).toBeNull();
  });
  test('a record is inside the range at both ends, whatever the time of day', () => {
    const r = { from: '2026-09-01', to: '2026-09-30' };
    expect(inExportRange('2026-09-01 00:00:00', r)).toBe(true);
    expect(inExportRange('2026-09-30T23:59:59', r)).toBe(true);
    expect(inExportRange('2026-10-01', r)).toBe(false);
    expect(inExportRange(null, r)).toBe(false);
    expect(inExportRange(null, null)).toBe(true);
  });
});

describe('the export button', () => {
  beforeEach(() => { writeFile.mockClear(); try { localStorage.clear(); } catch { /* none */ } });
  const wrap = el => render(<LocaleProvider>{el}</LocaleProvider>);

  test('an undated export downloads straight away, as before', async () => {
    wrap(<ExportButton data={[{ a: 1 }]} filename="Things" sheetName="S" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(writeFile).toHaveBeenCalled());
    expect(writeFile.mock.calls[0][1]).toBe('Things.xlsx');
  });

  test('a dated export asks for the period and passes it on', async () => {
    const fetchData = vi.fn(async () => [{ a: 1 }]);
    wrap(<ExportButton dated fetchData={fetchData} filename="Invoices" sheetName="S" />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(await screen.findByRole('radio', { name: /Last month/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /Download Excel/ }).at(-1));
    await waitFor(() => expect(writeFile).toHaveBeenCalled());
    const range = fetchData.mock.calls[0][0];
    expect(range).toEqual(exportPeriodRange('last_month'));
    expect(writeFile.mock.calls[0][1]).toBe(`Invoices_${range.from}_to_${range.to}.xlsx`);
  });

  test('all dates passes no range', async () => {
    const fetchData = vi.fn(async () => [{ a: 1 }]);
    wrap(<ExportButton dated fetchData={fetchData} filename="X" sheetName="S" />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(await screen.findByRole('radio', { name: /All dates/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /Download Excel/ }).at(-1));
    await waitFor(() => expect(fetchData).toHaveBeenCalledWith(null));
  });

  test('an empty period says so instead of downloading an empty file', async () => {
    wrap(<ExportButton dated fetchData={async () => []} filename="X" sheetName="S" />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByRole('button', { name: /Download Excel/ }).at(-1));
    await waitFor(() => expect(writeFile).not.toHaveBeenCalled());
  });
});

describe('the lists that export a period', () => {
  test('invoices and quotations send it to the server', () => {
    for (const src of [invoicesSrc, quotationsSrc]) {
      expect(src).toMatch(/date_from:\s+range\?\.from \|\| undefined/);
      expect(src).toMatch(/<ExportButton dated fetchData=\{fetchExportRows\}/);
    }
  });
  test('expenses and purchases filter on their own dates', () => {
    expect(expensesSrc).toMatch(/inExportRange\(e\.date, range\)/);
    expect(purchasesSrc).toMatch(/inExportRange\(p\.ordered_at \|\| p\.received_at, range\)/);
  });
  test('till sales ask the server for the whole period, not the latest 200', () => {
    expect(posSrc).toMatch(/getPosSales\(\{ date_from: range\?\.from \|\| undefined,[\s\S]*?limit: 0 \}\)/);
  });
});
