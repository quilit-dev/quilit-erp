import { expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { KpiCard } from '../pages/dashboard/ui.jsx';

test('KPI retains its exact amount, caption and real trend', () => {
  const { container } = render(<KpiCard label="Receivables" value="1,977,813,960 LBP"
    sub="Current period" trend={-4.2} sparkData={[12, 9, 7]} />);
  expect(screen.getByText('1,977,813,960 LBP')).toBeTruthy();
  expect(screen.getByText('Current period')).toBeTruthy();
  expect(screen.getByText('▼ 4.2%')).toBeTruthy();
  expect(container.querySelector('svg')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

test('clickable KPI supports mouse, Enter and Space without triggering on other keys', () => {
  const onClick = vi.fn();
  render(<KpiCard label="Revenue" value="$8,942" onClick={onClick} compact />);
  const card = screen.getByRole('button', { name: /Revenue/ });
  expect(card.tabIndex).toBe(0);
  fireEvent.click(card);
  fireEvent.keyDown(card, { key: 'Enter' });
  fireEvent.keyDown(card, { key: ' ' });
  fireEvent.keyDown(card, { key: 'ArrowDown' });
  expect(onClick).toHaveBeenCalledTimes(3);
});
