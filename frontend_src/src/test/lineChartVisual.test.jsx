import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test } from 'vitest';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { FinanceLineChart } from '../pages/finance/charts.jsx';
import { LineChart } from '../pages/reports/charts.jsx';

const rows = [
  { month: '2026-01', income: 12000, expenses: 8000, profit: 4000 },
  { month: '2026-02', income: 18000, expenses: 9000, profit: 9000 },
  { month: '2026-03', income: 15000, expenses: 11000, profit: 4000 },
];

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

describe('modern ERP line charts', () => {
  test('Finance keeps every point keyboard-readable and reveals its tooltip', () => {
    const { container } = render(
      <LocaleProvider><FinanceLineChart data={rows} /></LocaleProvider>,
    );
    expect(container.querySelector('pattern')).toBeTruthy();
    expect(container.querySelector('filter feDropShadow')).toBeTruthy();
    const january = screen.getByRole('img', { name: /Jan 26.*Income.*Expenses.*Profit/i });
    fireEvent.focus(january);
    expect(container.querySelector('foreignObject')).toBeTruthy();
    fireEvent.blur(january);
    expect(container.querySelector('foreignObject')).toBeNull();
  });

  test('Financial Reports uses the same visual language without changing its series', () => {
    const { container } = render(
      <LineChart data={rows} label1="Income" label2="Expenses" />,
    );
    expect(container.querySelectorAll('linearGradient')).toHaveLength(2);
    expect(container.querySelector('pattern')).toBeTruthy();
    expect(screen.getAllByRole('img')).toHaveLength(rows.length);
    expect(container.textContent).toContain('Income');
    expect(container.textContent).toContain('Expenses');
  });
});
