// The salary receipt an employee signs: it must show the working and add up.
import { describe, test, expect } from 'vitest';
import { buildSalaryReceiptHTML } from '../utils/salaryReceipt';
import panelSrc from '../pages/hr/PayrollRunPanel.jsx?raw';

const RUN = { id: 3, period_start: '2026-03-01', period_end: '2026-03-31' };
const SETTINGS = { company_name: 'Test Co', default_currency: 'USD' };

// Built with the server's own formula: contributory = base+bonus+ot+att,
// gross = contributory + transport, net = gross - every deduction.
const salaried = {
  id: 12, receipt_number: 'SAL-000012', paid_on: '2026-03-31', paid_method: 'Cash',
  employee_name: 'Ali Haidar', employee_code: 'E-7', job_title: 'Technician',
  salary_currency: 'USD', base_salary: 1000, bonuses: 50, overtime_amount: 75,
  overtime_hours: 5, attendance_bonus: 25, transport_allowance: 40, attended_days: 22,
  tax_amount: 30, nssf_employee: 35, insurance_employee: 10, late_deduction: 5,
  late_days: 1, deductions: 20, advance_recovery: 100,
  net_amount: 1000 + 50 + 75 + 25 + 40 - (30 + 35 + 10 + 5 + 20 + 100),
};

describe('the salary receipt', () => {
  test('earnings reach the gross and the deductions reach the net', () => {
    const r = buildSalaryReceiptHTML(salaried, RUN, SETTINGS);
    expect(r.gross).toBeCloseTo(1190);
    expect(r.deductions).toBeCloseTo(200);
    expect(r.gross - r.deductions).toBeCloseTo(salaried.net_amount);
    expect(r.net).toBeCloseTo(990);
  });

  test('carries the number, the person, the period and a place to sign', () => {
    const { html } = buildSalaryReceiptHTML(salaried, RUN, SETTINGS);
    expect(html).toContain('SAL-000012');
    expect(html).toContain('Ali Haidar');
    expect(html).toContain('إيصال راتب');
    expect(html).toContain('Employee Signature');
    expect(html).toContain('Advance recovered');
    expect(html).toContain('990.00 USD');
  });

  test('an hourly employee shows hours × rate, not a bare salary', () => {
    const { html } = buildSalaryReceiptHTML({
      ...salaried, hourly_rate: 12.5, hours_worked: 80, base_salary: 1000,
    }, RUN, SETTINGS);
    expect(html).toContain('Hours worked');
    expect(html).toContain('80 h × 12.50 USD');
    expect(html).not.toContain('Basic salary');
  });

  test('nothing that is zero clutters it', () => {
    const { html } = buildSalaryReceiptHTML({
      ...salaried, bonuses: 0, overtime_amount: 0, advance_recovery: 0,
      net_amount: salaried.net_amount - 50 - 75 + 100,
    }, RUN, SETTINGS);
    expect(html).not.toContain('Overtime');
    expect(html).not.toContain('Advance recovered');
  });
});

describe('the payroll run panel', () => {
  test('pays one employee on an approved run, and offers the receipt once paid', () => {
    expect(panelSrc).toMatch(/canPay=\{run\.status === 'Approved' && canApprove\}/);
    expect(panelSrc).toMatch(/line\.receipt_number \? \(/);
    expect(panelSrc).toMatch(/const r = await payPayrollLine\(line\.id, payout\)/);
  });
  test('the whole-run payout counts only those not yet paid', () => {
    expect(panelSrc).toMatch(/\.filter\(l => !l\.paid_on\)\.reduce/);
  });
});
