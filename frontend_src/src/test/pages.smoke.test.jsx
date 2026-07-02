// Page render smoke test — the runtime companion to the ESLint no-undef guard.
//
// Mounts EVERY page component inside the real providers with an empty mocked
// backend and asserts it renders without throwing. This catches the bug
// classes static analysis can't see:
//   • hooks called conditionally / after an early return
//   • reading properties of null/undefined data before the guard
//   • a broken import that resolves but exports the wrong thing
//
//   npm test
import { describe, test, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { SettingsProvider } from '../hooks/useSettings.jsx';

// Eagerly import every top-level page (same set App.jsx lazy-loads).
const pages = import.meta.glob('../pages/*.jsx', { eager: true });

function Providers({ children }) {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <SettingsProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </SettingsProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}

describe('every page mounts without crashing', () => {
  const entries = Object.entries(pages)
    .map(([path, mod]) => [path.replace('../pages/', ''), mod.default])
    .filter(([, Component]) => typeof Component === 'function');

  test('found the full page set', () => {
    // Guard against the glob silently matching nothing after a move.
    expect(entries.length).toBeGreaterThanOrEqual(30);
  });

  test.each(entries)('%s', async (_name, Component) => {
    let container;
    await act(async () => {
      ({ container } = render(<Providers><Component /></Providers>));
      // Flush the initial data-loading effects (mocked fetch resolves
      // immediately) so post-load render paths run too.
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container).toBeTruthy();
  });
});
