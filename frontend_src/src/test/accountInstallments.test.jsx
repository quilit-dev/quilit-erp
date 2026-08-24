// Two different things called instalments, and which setting governs which.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import modalSrc from '../pages/clients/CustomerPaymentModal.jsx?raw';
import planSrc from '../pages/invoices/PaymentPlan.jsx?raw';
import detailSrc from '../pages/ClientDetail.jsx?raw';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('a plan on one invoice is for everybody', () => {
  test('the invoice screen no longer gates it on the customer', () => {
    // Splitting a single document into agreed dates is how anybody sells
    // anything of size.
    expect(planSrc).not.toMatch(/client_allow_installments/);
    expect(planSrc).not.toMatch(/installments\.notApproved/);
  });

  test('the set-up button is offered whenever there is no plan yet', () => {
    expect(planSrc).toMatch(/canEdit && plan\.length === 0 && !open && \(/);
  });
});

describe('the account going on terms is what the setting governs', () => {
  test('the option only appears for an approved customer', () => {
    expect(modalSrc).toMatch(/const canPlan = !!client\?\.allow_installments/);
    expect(modalSrc).toMatch(/\{canPlan && \(/);
  });

  test('the plan is only sent when it was asked for and allowed', () => {
    expect(modalSrc).toMatch(/\.\.\.\(onPlan && canPlan \? \{/);
    expect(modalSrc).toMatch(/installment_plan: \{/);
  });

  test('it says what the schedule would cover', () => {
    // "Put the rest on a plan" without saying how much is not an agreement.
    expect(modalSrc).toMatch(/remainingAfter/);
    expect(modalSrc).toMatch(/clients\.planTheRestHint/);
    expect(en.clients.planTheRestHint).toMatch(/oldest invoice first/i);
  });

  test('the customer\'s usual terms prefill it', () => {
    expect(modalSrc).toMatch(/client\?\.default_installment_count/);
    expect(modalSrc).toMatch(/client\?\.default_installment_frequency/);
  });

  test('it reuses the one plan vocabulary', () => {
    for (const k of ['installments.count', 'installments.frequency',
                     'installments.firstDue', 'installments.monthly']) {
      expect(modalSrc, k).toContain(`t('${k}')`);
    }
  });
});

describe('the client\'s invoices can be exported', () => {
  test('as a document, with the same columns the table shows', () => {
    expect(detailSrc).toMatch(/<ExportButtons/);
    expect(detailSrc).toMatch(/invoiceExportColumns/);
  });

  test('the headers are translated, not hardcoded English', () => {
    expect(detailSrc).toMatch(/label: t\('reports\.invoiceNumber'\)/);
    expect(detailSrc).not.toMatch(/label: 'Invoice/);
  });

  test('the totals row is shaped the way exportReportPDF reads it', () => {
    // It indexes totals.columns by position and puts the label at 0. An array
    // renders the label twice and shifts every cell.
    expect(detailSrc).toMatch(/label: t\('reports\.total'\),\s*\n?\s*columns: \[null/);
  });
});

describe('translation', () => {
  test('the new keys resolve in both languages', () => {
    for (const k of ['clients.planTheRest', 'clients.planTheRestHint',
                     'clients.invoicesFor']) {
      expect(typeof lookup(en, k), k).toBe('string');
      expect(typeof lookup(ar, k), k).toBe('string');
    }
  });

  test('the interpolated keys name their parameters', () => {
    for (const [key, args] of [['clients.planTheRestHint', ['amount']],
                               ['clients.invoicesFor', ['name']]]) {
      for (const dict of [en, ar]) {
        const named = [...lookup(dict, key).matchAll(/\{\{(\w+)\}\}/g)]
          .map(m => m[1]).sort();
        expect(named, key).toEqual([...args].sort());
      }
    }
  });

  test('the Arabic is actually Arabic', () => {
    for (const k of ['planTheRest', 'planTheRestHint', 'invoicesFor']) {
      expect(/[؀-ۿ]/.test(ar.clients[k]), k).toBe(true);
    }
  });

  test('every key the payment modal uses resolves', () => {
    const keys = [...modalSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });
});
