// PageMasthead — behavioural tests, written BEFORE the component.
//
// Stage 3 is the first stage of the retheme that changes JSX, and 44 of the 65
// test files in this suite assert against raw source text. Those cannot tell
// you whether a header still renders its title or still fires its action; they
// only tell you the file still contains a string. So every component whose
// markup Stage 3 touches gets real render coverage first, and this is that
// coverage for the one it introduces.
//
// What a masthead owes the 33 pages that will adopt it: show the title, show
// the count line, put the actions where the operator expects them, and stay
// correct in Arabic. Nothing here asserts on colour or spacing — those are the
// parts that are allowed to change.
import { describe, test, expect, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import PageMasthead from '../components/PageMasthead.jsx';

function Providers({ children }) {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </LocaleProvider>
    </ThemeProvider>
  );
}

const mount = (ui) => {
  let container;
  act(() => {
    ({ container } = render(<Providers>{ui}</Providers>));
  });
  return container;
};

describe('PageMasthead', () => {
  test('shows the title', () => {
    const c = mount(<PageMasthead title="Invoices" />);
    expect(c.textContent).toContain('Invoices');
  });

  test('shows a subtitle when given one, and no empty node when not', () => {
    const withSub = mount(<PageMasthead title="Invoices" subtitle="184 total" />);
    expect(withSub.textContent).toContain('184 total');

    const without = mount(<PageMasthead title="Invoices" />);
    // An empty <p> still occupies its line-height and pushes the rule down, so
    // a page with no count line would sit differently from one with it.
    expect(without.querySelector('.page-subtitle')).toBeNull();
  });

  test('renders its actions and fires the original handler', () => {
    const onClick = vi.fn();
    const c = mount(
      <PageMasthead
        title="Invoices"
        actions={<button className="btn btn-primary" onClick={onClick}>New invoice</button>}
      />,
    );
    const btn = Array.from(c.querySelectorAll('button'))
      .find((b) => b.textContent === 'New invoice');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    // The whole point of the refactor is that handlers pass through untouched.
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('keeps the existing page-header classes', () => {
    // Adoption has to be additive: 33 pages share this CSS, and a masthead
    // that dropped the classes would restyle every one of them at once.
    const c = mount(<PageMasthead title="Invoices" subtitle="184 total" />);
    expect(c.querySelector('.page-header')).toBeTruthy();
    expect(c.querySelector('.page-title')).toBeTruthy();
    expect(c.querySelector('.page-subtitle')).toBeTruthy();
  });

  test('renders a breadcrumb trail with working links', () => {
    const c = mount(
      <PageMasthead
        title="Invoice INV-1"
        breadcrumb={[{ label: 'Invoices', to: '/invoices' }]}
      />,
    );
    const link = c.querySelector('a[href="/invoices"]');
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('Invoices');
  });

  test('uses a real heading element', () => {
    // Screen-reader navigation and the document outline both depend on it.
    const c = mount(<PageMasthead title="Invoices" />);
    const h1 = c.querySelector('h1');
    expect(h1).toBeTruthy();
    expect(h1.textContent).toBe('Invoices');
  });

  test('carries no physical left/right styling', () => {
    // The app ships Arabic. `marginLeft` survives a direction flip and lands
    // on the wrong side; `marginInlineStart` does not.
    const c = mount(
      <PageMasthead title="Invoices" actions={<button type="button">Go</button>} />,
    );
    const html = c.innerHTML;
    expect(html).not.toMatch(/margin-left|margin-right|padding-left|padding-right/);
  });

  test('survives an empty actions slot', () => {
    const c = mount(<PageMasthead title="Invoices" actions={null} />);
    expect(c.textContent).toContain('Invoices');
  });
});
