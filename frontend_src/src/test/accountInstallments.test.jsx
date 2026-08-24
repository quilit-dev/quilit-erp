// Two different things called instalments, and which setting governs which.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import modalSrc from '../pages/clients/CustomerPaymentModal.jsx?raw';
import planSrc from '../pages/invoices/PaymentPlan.jsx?raw';
import acctSrc from '../pages/clients/AccountPlan.jsx?raw';
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
    expect(acctSrc).toMatch(/const allowed = !!client\?\.allow_installments/);
    expect(acctSrc).toMatch(/allowed && !plan && !open && \(/);
    // And the payment form says so rather than offering a second one, since
    // the server refuses that.
    expect(modalSrc).toMatch(/\{canPlan && !existing && \(/);
  });

  test('terms are agreed in the panel, not as a side effect of a payment', () => {
    // The same division as an invoice: the plan lives in its own panel and
    // the payment form only takes money. Agreeing a schedule because a box
    // happened to be ticked is how a plan appears that nobody sat down and
    // agreed to.
    expect(modalSrc).not.toMatch(/installment_plan: \{/);
    expect(modalSrc).toMatch(/clients\.planLivesOnOverview/);
    expect(en.clients.planLivesOnOverview).toMatch(/overview/i);
  });

  test('the panel says where the terms are agreed and what they cover', () => {
    expect(acctSrc).toMatch(/createClientPlan/);
    expect(acctSrc).toMatch(/clients\.planSplitHint/);
    expect(en.clients.planSplitHint).toMatch(/whole account balance/i);
  });

  test('a customer’s usual terms prefill it', () => {
    expect(acctSrc).toMatch(/client\?\.default_installment_count/);
    expect(acctSrc).toMatch(/client\?\.default_installment_frequency/);
  });

  test('it reuses the one plan vocabulary', () => {
    // The same words in both panels, because it is the same idea.
    for (const k of ['installments.count', 'installments.frequency',
                     'installments.firstDue', 'installments.monthly',
                     'installments.deposit']) {
      expect(acctSrc, k).toContain(`t('${k}')`);
      expect(planSrc, k).toContain(`t('${k}')`);
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
