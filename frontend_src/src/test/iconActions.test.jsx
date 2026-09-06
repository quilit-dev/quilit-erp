import { describe, test, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { ExportButton, FileDownloadButton, Icon, IconButton } from '../components/shared.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';

describe('IconButton', () => {
  test('keeps the action discoverable and accessible without visible text', () => {
    const onClick = vi.fn();
    render(<IconButton icon="pencil" label="Edit" onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Edit' });
    expect(button.getAttribute('title')).toBe('Edit');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('btn-icon');
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  test('preserves the variant, disabled state, style and icon size', () => {
    render(
      <IconButton
        icon="trash"
        label="Delete"
        className="btn btn-sm btn-danger"
        disabled
        iconSize={18}
        style={{ opacity: 0.6 }}
      />,
    );

    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.disabled).toBe(true);
    expect(button.className).toContain('btn-danger');
    expect(button.style.opacity).toBe('0.6');
    expect(button.querySelector('svg')?.getAttribute('width')).toBe('18');
  });

  test('uses a fallback glyph instead of shipping a blank control', () => {
    render(<IconButton icon="not-a-real-icon" label="Custom action" />);
    const svg = screen.getByRole('button', { name: 'Custom action' }).querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.innerHTML.length).toBeGreaterThan(10);
  });

});

describe('the standardized action glyphs', () => {
  test.each([
    'sliders',
    'clock',
    'pencil',
    'archive',
    'trash',
    'rotate-ccw',
    'eye',
    'download-excel',
    'download-pdf',
  ])('%s renders an SVG path', (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.innerHTML.length).toBeGreaterThan(10);
  });
});

describe('file export actions', () => {
  test('the shared Excel export clearly identifies its file format', () => {
    render(<LocaleProvider><ExportButton data={[{ total: 42 }]} filename="Report" /></LocaleProvider>);
    const button = screen.getByRole('button', { name: 'Download Excel' });
    expect(button.children).toHaveLength(2);
    expect(button.firstElementChild?.tagName).toBe('svg');
    expect(button.lastElementChild?.textContent).toBe('XLS');
    expect(button.className).toContain('is-excel');
  });

  test('PDF downloads use an explicit PDF marker', () => {
    render(<FileDownloadButton format="pdf" label="Download PDF" />);
    const button = screen.getByRole('button', { name: 'Download PDF' });
    expect(button.firstElementChild?.tagName).toBe('svg');
    expect(button.lastElementChild?.textContent).toBe('PDF');
    expect(button.className).toContain('is-pdf');
  });
});
