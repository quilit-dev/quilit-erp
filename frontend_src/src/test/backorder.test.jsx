// Selling what is not on the shelf yet.
//
// A customer wants five, there are two, the manager says the rest can be got.
// The two leave at the till; the three are a promise, and the customer's money
// waits in deferred revenue until they get them.
//
// These pin the screens. The arithmetic, the postings and the allocation are
// pinned on the server, where they happen.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import posSrc from '../pages/POS.jsx?raw';
import checkoutSrc from '../pages/pos/CheckoutModal.jsx?raw';
import waitingSrc from '../pages/pos/WaitingView.jsx?raw';
import apiSrc from '../api/client.js?raw';

describe('the till offers the way through, rather than a dead end', () => {
  test('the shortfall dialog is opened by the server refusing', () => {
    // The numbers in it are the server's — it measured the shortfall a moment
    // ago. Recomputing them in the browser would be a second opinion that can
    // disagree with the one that matters.
    expect(checkoutSrc).toMatch(/Insufficient stock/);
    expect(checkoutSrc).toMatch(/setShortfall\(e\.message\)/);
  });

  test('and only for a named customer', () => {
    // Somebody has to be given the goods when they arrive.
    expect(checkoutSrc).toMatch(/short && !allowBackorder && clientId/);
    expect(checkoutSrc).toMatch(/pos\.shortNeedsCustomer/);
  });

  test('confirming re-sends the sale with permission to fall back', () => {
    expect(checkoutSrc).toMatch(/confirm\(\{ allowBackorder: true \}\)/);
    expect(checkoutSrc).toMatch(/allow_backorder: true/);
  });

  test('the ordinary confirm button does not back-order by accident', () => {
    // A click handler is passed the event. `onClick={confirm}` would hand the
    // event in as options, and `allowBackorder` would read truthy on every
    // sale — quietly turning the refusal off for the whole till.
    expect(checkoutSrc).toMatch(/onClick=\{\(\) => confirm\(\)\}/);
    expect(checkoutSrc).not.toMatch(/onClick=\{confirm\}/);
  });

  test('it says what the customer is agreeing to', () => {
    for (const k of ['shortTitle', 'shortExplain', 'shortPointStock',
                     'shortPointMoney', 'shortPointList', 'shortConfirm']) {
      expect(en.pos[k], k).toBeTruthy();
      expect(ar.pos[k], k).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('the list of people waiting', () => {
  test('lives beside the till, not two screens away', () => {
    // The person who needs it is the one who made the promise and will take
    // the phone call.
    expect(posSrc).toMatch(/WaitingView/);
    expect(posSrc).toMatch(/key: 'waiting'/);
  });

  test('and carries a badge for what can be collected today', () => {
    // Open commitments are a backlog; ready ones are a call to make.
    expect(posSrc).toMatch(/getCommitmentCount/);
    expect(posSrc).toMatch(/badge: waiting\.ready/);
  });

  test('ready rows sort to the top', () => {
    expect(waitingSrc).toMatch(/\(b\.ready > 0\) - \(a\.ready > 0\)/);
  });

  test('hand over is refused until it has arrived', () => {
    expect(waitingSrc).toMatch(/disabled=\{r\.ready <= 0/);
    expect(waitingSrc).toMatch(/waiting\.notInYet/);
  });

  test('the customer’s phone number is on the row', () => {
    // The whole point of the screen is ringing them.
    expect(waitingSrc).toMatch(/client_phone/);
  });

  test('cancelling asks whether the money goes back now', () => {
    // It was never earned, so it is theirs either way — the question is only
    // whether it leaves the till today or stays as credit.
    expect(waitingSrc).toMatch(/refund/);
    expect(en.waiting.refundNow).toMatch(/\{\{amt\}\}/);
    expect(ar.waiting.refundNow).toMatch(/\{\{amt\}\}/);
  });

  test('every string it shows exists in both languages', () => {
    expect(Object.keys(en.waiting).sort()).toEqual(Object.keys(ar.waiting).sort());
    for (const [k, v] of Object.entries(en.waiting)) {
      const named = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)]
        .map(m => m[1]).sort().join(',');
      expect(named(ar.waiting[k]), k).toBe(named(v));
    }
  });

  test('the Arabic is Arabic', () => {
    for (const [k, v] of Object.entries(ar.waiting)) {
      expect(/[؀-ۿ]/.test(v), k).toBe(true);
    }
  });

  test('it renders no key that does not exist', () => {
    // A t() miss prints the key itself on screen — which is exactly what the
    // first draft of this table did with common.item and common.value.
    const keys = [...waitingSrc.matchAll(/t\('([a-z]+)\.([a-zA-Z]+)'/g)]
      .map(m => [m[1], m[2]]);
    expect(keys.length).toBeGreaterThan(5);
    for (const [ns, k] of keys) {
      expect(en[ns]?.[k], `en.${ns}.${k}`).toBeTruthy();
    }
  });
});

describe('the API surface', () => {
  test('commitments are their own resource, not part of the till', () => {
    // The same promise can be made from an invoice, and collecting one is not
    // a register event — it happens on another day, often by somebody else.
    expect(apiSrc).toMatch(/\/api\/commitments\//);
    expect(apiSrc).toMatch(/deliverCommitment/);
    expect(apiSrc).toMatch(/cancelCommitment/);
  });
});
