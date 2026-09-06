import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test } from 'vitest';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import en from '../locales/en.js';
import ar from '../locales/ar.js';
import { ProfitBarChart } from '../pages/finance/charts.jsx';
import { HBarChart, VBarChart } from '../pages/reports/charts.jsx';

const rows = [
  { month: '2026-01', income: 12000, expenses: 8000, profit: 4000, category: 'Rent', total: 8000 },
  { month: '2026-02', income: 9000, expenses: 11000, profit: -2000, category: 'Fuel', total: 3000 },
];

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

describe('modern ERP bar charts', () => {
  test('profit bars preserve positive and negative values with keyboard tooltips', () => {
    const { container } = render(
      <LocaleProvider><ProfitBarChart data={rows} /></LocaleProvider>,
    );
    expect(container.querySelectorAll('linearGradient')).toHaveLength(2);
    expect(container.querySelectorAll('[data-bar-cap="true"]')).toHaveLength(rows.length);
    const january = screen.getByRole('img', { name: /Jan 26.*Profit.*\$4.*k/i });
    fireEvent.focus(january);
    expect(container.querySelector('foreignObject')).toBeTruthy();
  });

  test('horizontal and vertical charts expose every bar value', () => {
    const horizontal = render(<HBarChart data={rows} labelKey="category" valueKey="total" />);
    expect(screen.getByRole('img', { name: /Rent.*\$8.*k/i })).toBeTruthy();
    expect(horizontal.container.querySelectorAll('[data-bar-cap="true"]')).toHaveLength(rows.length);
    horizontal.unmount();

    const vertical = render(<VBarChart data={rows} labelKey="month" valueKey="total" />);
    expect(screen.getByRole('img', { name: /Jan 26.*\$8.*k/i })).toBeTruthy();
    expect(vertical.container.querySelectorAll('[data-bar-cap="true"]')).toHaveLength(rows.length);
  });

  test('bar-chart titles and table labels are translated in both themes', () => {
    for (const locale of [en, ar]) {
      expect(locale.reports.byStatusValue).toBeTruthy();
      expect(locale.reports.share).toBeTruthy();
      expect(locale.reports.monthlyVolume).toBeTruthy();
    }
  });
});
