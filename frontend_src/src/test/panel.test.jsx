// Panel — behavioural tests, written before the component.
//
// `.card` / `.card-header` already exist and are used on nearly every screen.
// What did not exist was a shape: the header was overridden inline about
// fifteen times, in exactly two ways — a title-and-actions split, and a
// stacked filter bar. Those two are what this encodes. Anything else stays a
// plain `.card`, deliberately: a primitive that tries to cover every case ends
// up taking a dozen props and is harder to read than the markup it replaced.
import { describe, test, expect, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import Panel, { PanelHeader, PanelBody } from '../components/Panel.jsx';

const mount = (ui) => {
  let container;
  act(() => {
    ({ container } = render(ui));
  });
  return container;
};

describe('Panel', () => {
  test('renders its children inside a card', () => {
    const c = mount(<Panel><p>Rows go here</p></Panel>);
    expect(c.querySelector('.card')).toBeTruthy();
    expect(c.textContent).toContain('Rows go here');
  });

  test('passes through extra class names', () => {
    // Pages rely on their own modifiers; a primitive that swallowed className
    // would silently drop them.
    const c = mount(<Panel className="pos-panel">x</Panel>);
    const card = c.querySelector('.card');
    expect(card.className).toContain('card');
    expect(card.className).toContain('pos-panel');
  });

  test('forwards arbitrary props such as id and data attributes', () => {
    const c = mount(<Panel id="totals" data-testid="totals-panel">x</Panel>);
    expect(c.querySelector('#totals')).toBeTruthy();
    expect(c.querySelector('[data-testid="totals-panel"]')).toBeTruthy();
  });
});

describe('PanelHeader', () => {
  test('splits a title from its actions', () => {
    const onClick = vi.fn();
    const c = mount(
      <Panel>
        <PanelHeader title="Invoices" actions={<button onClick={onClick}>Export</button>} />
      </Panel>,
    );
    expect(c.textContent).toContain('Invoices');
    const btn = Array.from(c.querySelectorAll('button')).find((b) => b.textContent === 'Export');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('keeps the card-header class so existing CSS still applies', () => {
    const c = mount(<Panel><PanelHeader title="Invoices" /></Panel>);
    expect(c.querySelector('.card-header')).toBeTruthy();
  });

  test('stacked mode is a separate shape, not an inline override', () => {
    // This is the filter-bar case: the header holds a full-width row of
    // controls rather than a title and a button.
    const c = mount(
      <Panel><PanelHeader stacked><input aria-label="Search" /></PanelHeader></Panel>,
    );
    const header = c.querySelector('.card-header');
    expect(header.className).toContain('card-header-stacked');
    expect(c.querySelector('input')).toBeTruthy();
  });

  test('renders children directly when no title is given', () => {
    const c = mount(<Panel><PanelHeader><span>Custom</span></PanelHeader></Panel>);
    expect(c.textContent).toContain('Custom');
  });

  test('carries no physical left/right styling', () => {
    const c = mount(
      <Panel><PanelHeader title="Invoices" actions={<button>Go</button>} /></Panel>,
    );
    expect(c.innerHTML).not.toMatch(/margin-left|margin-right|padding-left|padding-right/);
  });
});

describe('PanelBody', () => {
  test('renders its children', () => {
    const c = mount(<Panel><PanelBody>Body text</PanelBody></Panel>);
    expect(c.textContent).toContain('Body text');
    expect(c.querySelector('.card-body')).toBeTruthy();
  });
});
