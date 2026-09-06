// The service report has one job: not to invent a number.
//
// A job attended by two technicians counts once for the business and once for
// each of them, so the per-person column legitimately adds up to more than the
// jobs completed above it. That is a table whose columns do not reconcile —
// which is fine as long as it says so, and fatal if it does not, because the
// obvious fix a reader applies is to add the column up.
//
// Two rules follow, and both are asserted here:
//   * no total row under the technician table, ever;
//   * the explanation appears exactly when the overlap is real, so it reads as
//     an explanation rather than boilerplate nobody finishes.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import en from '../locales/en';
import ar from '../locales/ar';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'reports', 'ServiceReport.jsx'),
  'utf8',
);

const REPORT = {
  jobs: [],
  totals: { completed_jobs: 2, revenue: 777, unbilled_count: 0, unbilled_value: 0 },
  by_technician: [
    { employee_id: 1, name: 'Omar Haddad', job_title: 'Technician', jobs: 1, value_attended: 555, days_present: 18 },
    { employee_id: 2, name: 'Tarek Aoun', job_title: 'Technician', jobs: 1, value_attended: 555, days_present: 20 },
    { employee_id: 3, name: 'Layal Nasr', job_title: 'Technician', jobs: 1, value_attended: 222, days_present: 14 },
  ],
  technician_rows_overlap: true,
  attendance_visible: true,
};

/** The same period seen by somebody with reports access but not HR: the server
 *  omits `days_present` entirely rather than sending a zero. */
const WITHHELD = {
  ...REPORT,
  attendance_visible: false,
  by_technician: REPORT.by_technician.map(({ days_present, ...rest }) => rest),
};

vi.mock('../api/client', () => ({
  getServiceJobsReport: vi.fn(() => Promise.resolve(globalThis.__report)),
}));

const t = (k) => k;

async function mount(report) {
  globalThis.__report = report;
  const { ServiceReport } = await import('../pages/reports/ServiceReport.jsx');
  let container;
  await act(async () => {
    ({ container } = render(
      <ThemeProvider><LocaleProvider><MemoryRouter>
        <ServiceReport params={{ start: 'a', end: 'b' }} t={t} />
      </MemoryRouter></LocaleProvider></ThemeProvider>));
  });
  return container;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('the technician table never totals itself', () => {
  test('it renders a row per technician', async () => {
    const c = await mount(REPORT);
    expect(c.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  test('there is no tfoot under it', async () => {
    // Summing Jobs would report three services from two, and summing Value
    // would invent $555 the business never earned.
    const c = await mount(REPORT);
    expect(c.querySelector('tfoot'), 'a total under this table is a wrong number')
      .toBeNull();
  });

  test('the source carries no total row either', () => {
    expect(src).not.toMatch(/<tfoot/);
  });

  test('the headline figures come from the totals block, not the rows', async () => {
    // 2 jobs completed, even though three technician rows are shown.
    const c = await mount(REPORT);
    const cards = [...c.querySelectorAll('.stat-card')].map(x => x.textContent);
    expect(cards.some(x => x.includes('2')), 'jobs completed is the true count').toBe(true);
    const rowSum = REPORT.by_technician.reduce((s, r) => s + r.jobs, 0);
    expect(rowSum).toBeGreaterThan(REPORT.totals.completed_jobs);
  });
});

describe('the note explains the discrepancy, and only when there is one', () => {
  test('it appears when a job was shared', async () => {
    const c = await mount(REPORT);
    expect(c.textContent).toContain('service.sharedJobsNote');
  });

  test('it stays away when every job had one technician', async () => {
    const solo = {
      ...REPORT,
      totals: { ...REPORT.totals, completed_jobs: 3 },
      technician_rows_overlap: false,
    };
    const c = await mount(solo);
    expect(c.textContent).not.toContain('service.sharedJobsNote');
  });

  test('the note is driven by the server, not recomputed on the client', () => {
    // The server knows whether any completed job actually had a crew of more
    // than one. Guessing from `sum(rows) > completed` on the client would get
    // it wrong the moment the report is filtered.
    expect(src).toMatch(/data\.technician_rows_overlap/);
  });
});

describe('both languages', () => {
  test.each(['technicians', 'technician', 'jobsCompleted', 'valueAttended',
             'byTechnician', 'sharedJobsNote', 'noCompletedJobs', 'noTechnicians'])(
    'service.%s is translated', (key) => {
      expect(en.service[key], `en.service.${key}`).toBeTruthy();
      expect(ar.service[key], `ar.service.${key}`).toBeTruthy();
      expect(ar.service[key]).not.toBe(en.service[key]);
    });

  test('the Reports tab has a label in both', () => {
    expect(en.reports.service).toBeTruthy();
    expect(ar.reports.service).toBeTruthy();
    expect(ar.reports.service).not.toBe(en.reports.service);
  });
});


describe('days present is HR data and the column follows the permission', () => {
  test('it shows for a viewer who holds HR', async () => {
    const c = await mount(REPORT);
    expect(c.textContent).toContain('service.daysPresent');
    expect(c.textContent).toContain('18');
  });

  test('the column is GONE for a viewer without it, not blank', async () => {
    // A blank cell invites "he was never here". So does a zero. The header has
    // to go too, or the table reads as data that failed to load.
    const c = await mount(WITHHELD);
    expect(c.textContent).not.toContain('service.daysPresent');
    const headerCount = c.querySelectorAll('thead th').length;
    const cellCount = c.querySelector('tbody tr').querySelectorAll('td').length;
    expect(cellCount, 'every row must match the header it sits under')
      .toBe(headerCount);
  });

  test('the service figures are untouched by the permission', async () => {
    // Job counts are not personnel data; withholding attendance must not
    // quietly withhold the thing the viewer came for.
    const c = await mount(WITHHELD);
    expect(c.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(c.textContent).toContain('Omar Haddad');
  });

  test('the column is driven by the server flag, not by probing a row', () => {
    // `rows[0].days_present !== undefined` would work until the first period
    // where the top technician happens to have no attendance recorded.
    expect(src).toMatch(/data\.attendance_visible/);
  });
});

describe('an idle technician is a row, not an omission', () => {
  test('zero jobs still renders', async () => {
    const idle = {
      ...REPORT,
      by_technician: [{ employee_id: 9, name: 'Workshop Sami', job_title: 'Technician',
                        jobs: 0, value_attended: 0, days_present: 20, field_staff: true }],
      technician_rows_overlap: false,
    };
    const c = await mount(idle);
    expect(c.textContent).toContain('Workshop Sami');
    expect(c.textContent).toContain('20');
  });
});
