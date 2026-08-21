// The billing facts on a customer, and their statement of account.
//
// The checks are the ones that have caught real breakage on this codebase: a
// translation key with no entry renders as the key itself, an invented class
// name renders unstyled, and a form-control dropped into a flex row with no
// width takes the whole line. All three pass every behavioural test.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import clientsSrc from '../pages/Clients.jsx?raw';
import detailSrc from '../pages/ClientDetail.jsx?raw';
import statementSrc from '../pages/clients/StatementTab.jsx?raw';
import apiSrc from '../api/client.js?raw';
import uiSrc from '../pages/settings/ui.jsx?raw';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

// ── The form ─────────────────────────────────────────────────────────────────

describe('the customer form carries the billing facts', () => {
  test('all four reach the payload', () => {
    for (const field of ['financial_id', 'preferred_currency', 'vat_status',
                         'allow_installments']) {
      expect(clientsSrc, field).toContain(field);
    }
  });

  test('unset is sent as null, not an empty string', () => {
    // The API stores NULL for "whatever the company bills in". Sending '' would
    // persist an empty currency, which is not the same thing.
    expect(clientsSrc).toMatch(/preferred_currency: form\.preferred_currency \|\| null/);
    expect(clientsSrc).toMatch(/default_installment_frequency: form\.default_installment_frequency \|\| null/);
  });

  test('a stored row loads back into the form without nulls leaking in', () => {
    // A NULL in a controlled input turns it into an uncontrolled one and React
    // warns; worse, the field silently stops updating.
    expect(clientsSrc).toMatch(/financial_id: c\.financial_id \|\| ''/);
    expect(clientsSrc).toMatch(/default_installment_count: c\.default_installment_count \?\? ''/);
  });

  test('the instalment defaults only appear when instalments are allowed', () => {
    expect(clientsSrc).toMatch(/\{form\.allow_installments && \(/);
  });

  test('EUR is offered now that the backend supports it', () => {
    // It arrived with the effective-dated rates and would otherwise have been
    // unreachable from any screen.
    expect(uiSrc).toMatch(/CURRENCIES = \['USD', 'LBP', 'EUR'\]/);
  });
});

// ── The statement ────────────────────────────────────────────────────────────

describe('the statement is reachable and exportable', () => {
  test('the detail page has a tab that renders it', () => {
    expect(detailSrc).toMatch(/key: 'statement'/);
    expect(detailSrc).toMatch(/tab === 'statement' && <StatementTab/);
  });

  test('the API call exists', () => {
    expect(apiSrc).toMatch(/getClientStatement/);
    expect(apiSrc).toMatch(/\/statement\$\{_qs\(params\)\}/);
  });

  test('it exports what it shows', () => {
    // Same columns for the table and the export, so the PDF cannot drift from
    // the screen.
    expect(statementSrc).toMatch(/<ExportButtons/);
    expect(statementSrc).toMatch(/rows=\{movements\} columns=\{columns\}/);
  });

  test('it has loading, error and empty states', () => {
    expect(statementSrc).toMatch(/<LoadingSpinner \/>/);
    expect(statementSrc).toMatch(/<ErrorAlert/);
    expect(statementSrc).toMatch(/<EmptyState/);
  });

  test('a late response for a previous customer cannot overwrite the current one', () => {
    // The window changes on every keystroke of a date field; without the guard
    // the slowest request wins rather than the newest.
    expect(statementSrc).toMatch(/let alive = true/);
    expect(statementSrc).toMatch(/return \(\) => \{ alive = false; \}/);
  });
});

// ── Styling that has regressed before ────────────────────────────────────────

describe('the statement is laid out like the rest of the app', () => {
  test('every control in its bar has an explicit width', () => {
    // .form-control is width:100%. Dropped into a flex row unconstrained, each
    // control claims a whole line — exactly how the service filters shipped.
    const bar = statementSrc.slice(
      statementSrc.indexOf('className="search-bar"'),
      statementSrc.indexOf('</div>', statementSrc.indexOf('ExportButtons')));
    const tags = bar.split('<input').slice(1)
      .map(chunk => chunk.slice(0, chunk.indexOf('/>')));
    expect(tags.length).toBeGreaterThan(1);
    for (const tag of tags) {
      expect(tag, tag.slice(0, 60)).toMatch(/style=\{\{ width:/);
    }
  });

  test('no invented class names', () => {
    const used = new Set();
    for (const m of statementSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);

    // From disk: vite.config sets css:false for tests, so the bundler route
    // would compare against an empty stylesheet and always pass.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    expect(css.length).toBeGreaterThan(1000);
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));

    expect([...used].filter(c => !defined.has(c)).sort()).toEqual([]);
  });
});

// ── Both languages ───────────────────────────────────────────────────────────

describe('both languages', () => {
  const KEYS = [
    'clients.billingHeading', 'clients.financialId', 'clients.preferredCurrency',
    'clients.currencyCompanyDefault', 'clients.vatStatus', 'clients.vatSubject',
    'clients.vatExempt', 'clients.vatExemptHint', 'clients.installments',
    'clients.allowInstallments', 'clients.defaultCount', 'clients.defaultFrequency',
    'clients.installmentsHint', 'clients.statement', 'clients.statementFor',
    'clients.openingBalance', 'clients.closingBalance', 'clients.charged',
    'clients.movementDate', 'clients.noMovements',
  ];

  test('every key exists in both', () => {
    expect(KEYS.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(KEYS.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('the Arabic is actually Arabic', () => {
    const latinOnly = KEYS.filter(k => {
      const v = lookup(ar, k);
      return /[A-Za-z]{3,}/.test(v) && !/[؀-ۿ]/.test(v);
    });
    expect(latinOnly).toEqual([]);
  });

  test('every key the statement uses resolves', () => {
    const keys = [...statementSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(8);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('statementFor is given the parameter it names', () => {
    // Called bare it renders "Statement — {{name}}" on the PDF title.
    const named = [...en.clients.statementFor.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
    expect(named).toEqual(['name']);
    expect(statementSrc).toMatch(/statementFor', \{ name:/);
  });
});
