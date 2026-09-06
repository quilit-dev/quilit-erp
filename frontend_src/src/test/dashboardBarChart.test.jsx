import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { BarChart } from '../pages/dashboard/ui.jsx';

const data = [
  { month: '2026-01', income: 12000, expenses: 8000 },
  { month: '2026-02', income: 18000, expenses: 9000 },
];

function renderChart() {
  return render(
    <LocaleProvider>
      <BarChart data={data} incomeLabel="Revenue" expensesLabel="Expenses" />
    </LocaleProvider>,
  );
}

describe('dashboard revenue and expenses chart', () => {
  test('keeps both series and every month accessible', () => {
    renderChart();
    expect(screen.getByRole('group', { name: 'Revenue / Expenses' })).toBeTruthy();
    expect(screen.getByRole('group', {
      name: /Jan\. Revenue: \$12,000\. Expenses: \$8,000\./,
    })).toBeTruthy();
    expect(screen.getByRole('group', {
      name: /Feb\. Revenue: \$18,000\. Expenses: \$9,000\./,
    })).toBeTruthy();
  });

  test('formats year-month API keys as distinct month names', () => {
    const { container } = renderChart();
    const labels = [...container.querySelectorAll('.dash-bar-month')].map(node => node.textContent);
    expect(labels).toEqual(['Jan', 'Feb']);
    expect(labels).not.toContain('202');
  });

  test('shows the detailed tooltip for keyboard users', () => {
    renderChart();
    const january = screen.getByRole('group', { name: /Jan\. Revenue:/ });
    fireEvent.focus(january);
    expect(screen.getByRole('tooltip').textContent).toContain('Jan');
    expect(screen.getByRole('tooltip').textContent).toContain('$12,000');
    expect(screen.getByRole('tooltip').textContent).toContain('$8,000');
    fireEvent.blur(january);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
