import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TimeClockTab from '../pages/hr/TimeClockTab.jsx';
import { createTimeDevice, createWorkSchedule } from '../api/client';

vi.mock('../api/client', () => ({
  getTimeDevices: vi.fn(async () => []),
  getDeviceUsers: vi.fn(async () => []),
  getWorkSchedules: vi.fn(async () => []),
  createTimeDevice: vi.fn(async () => ({ name: 'Entrance', token: 'test-token' })),
  createWorkSchedule: vi.fn(async () => ({})),
  rotateTimeDevice: vi.fn(), revokeTimeDevice: vi.fn(), setDeviceUser: vi.fn(),
  updateWorkSchedule: vi.fn(), archiveWorkSchedule: vi.fn(),
}));
vi.mock('../hooks/useSettings.jsx', () => ({ useSettings: () => ({ settings: {} }) }));
vi.mock('../hooks/useLocale.jsx', () => ({ useLocale: () => ({ t: key => key }) }));

beforeEach(() => vi.clearAllMocks());

test('Add Terminal uses a labelled themed field and preserves the saved name', async () => {
  render(<TimeClockTab t={key => key} canEdit />);
  fireEvent.click(await screen.findByRole('button', { name: 'timeclock.addDevice' }));
  const name = screen.getByLabelText('common.name');
  expect(name.classList.contains('form-control')).toBe(true);
  expect(screen.getByRole('button', { name: 'common.save' }).disabled).toBe(true);
  fireEvent.change(name, { target: { value: ' Entrance ' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(createTimeDevice).toHaveBeenCalledWith({ name: 'Entrance' }));
  expect(await screen.findByText('timeclock.tokenOnce')).toBeTruthy();
});

test('Working Days styles every field and preserves schedule values and day selection', async () => {
  render(<TimeClockTab t={key => key} canEdit />);
  fireEvent.click(await screen.findByRole('button', { name: 'timeclock.addSchedule' }));
  for (const label of ['common.name', 'timeclock.startTime', 'timeclock.endTime',
    'timeclock.graceLabel', 'timeclock.halfDayLabel', 'timeclock.breakLabel']) {
    expect(screen.getByLabelText(label).classList.contains('form-control')).toBe(true);
  }
  fireEvent.change(screen.getByLabelText('common.name'), { target: { value: 'Office' } });
  const monday = screen.getByRole('button', { name: 'timeclock.mon' });
  expect(monday.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(monday);
  expect(monday.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(createWorkSchedule).toHaveBeenCalledWith({
    name: 'Office', is_default: false, start_time: '08:00', end_time: '17:00',
    break_minutes: 0, grace_minutes: 15, min_hours_full_day: 6,
    workdays: '2,3,4,5', crosses_midnight: false,
  }));
});
