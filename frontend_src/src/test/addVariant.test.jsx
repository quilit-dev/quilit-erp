// Adding a variant to a product that already exists. Until this the builder
// was the only way to make one, and only on the day the product was created.
import { describe, test, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import SearchSelect from '../components/SearchSelect.jsx';
import inventorySrc from '../pages/Inventory.jsx?raw';
import modalSrc from '../pages/inventory/AddVariantModal.jsx?raw';
import clientSrc from '../api/client.js?raw';

describe('the product group row', () => {
  test('offers "Add variant" to someone who may create stock', () => {
    expect(inventorySrc).toMatch(/can\('inventory', 'create'\) && \(\s*<button[^]*?setVariantFor\(pid\)/);
    // In the actions column, with an icon, like the row actions beside it.
    expect(inventorySrc).toMatch(/<Icon name="layers-plus" size=\{14\} \/>\s*\{t\('inventory\.addVariantBtn'\)\}/);
    // The click must not fold the group it sits in.
    expect(inventorySrc).toMatch(/e\.stopPropagation\(\); setVariantFor\(pid\)/);
  });
  test('opens the modal and reloads the list on save', () => {
    expect(inventorySrc).toMatch(/<AddVariantModal productId=\{variantFor\}/);
    expect(inventorySrc).toMatch(/onSaved=\{\(\) => \{ setVariantFor\(null\); load\(\); \}\}/);
  });
});

describe('the modal', () => {
  test('takes its axes from the product\'s own variants, not every defined field', () => {
    expect(modalSrc).toMatch(/for \(const v of product\.variants \|\| \[\]\)/);
    expect(modalSrc).toMatch(/Object\.entries\(v\.attributes \|\| \{\}\)/);
  });
  test('offers known values in the app dropdown and lets a new one be typed', () => {
    expect(modalSrc).toMatch(/<SearchSelect className="form-control" value=\{values\[a\.name\] \|\| ''\}/);
    expect(modalSrc).toMatch(/onCreate=\{v => setExtra/);
  });
  test('leaves price and cost to the siblings unless typed', () => {
    expect(modalSrc).toMatch(/sale_price: form\.sale_price === '' \? null : Number\(form\.sale_price\)/);
    expect(modalSrc).toMatch(/unit_cost: form\.unit_cost === '' \? null : Number\(form\.unit_cost\)/);
    // And does not show cost to someone without the permission.
    expect(modalSrc).toMatch(/\{showCost && \(/);
  });
  test('refuses a duplicate before asking the server', () => {
    expect(modalSrc).toMatch(/const duplicate = preview && siblings\.some/);
    expect(modalSrc).toMatch(/disabled=\{saving \|\| !complete \|\| duplicate\}/);
  });
  test('posts to the variants endpoint', () => {
    expect(clientSrc).toMatch(/addProductVariant\s*=\s*\(id, d\) => api\.post\(`\/api\/products\/\$\{id\}\/variants`, d\)/);
  });
});

describe('SearchSelect with onCreate', () => {
  test('offers the typed text as a new value when no option is it', () => {
    const created = [];
    let value = '';
    const wrap = (ui) => <LocaleProvider>{ui}</LocaleProvider>;
    const { rerender } = render(wrap(
      <SearchSelect value={value} onChange={v => { value = v; }} onCreate={v => created.push(v)}
        options={[{ value: 'S', label: 'S' }, { value: 'M', label: 'M' }]} placeholder="Pick" allowBlank={false} />));
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'XL' } });
    const row = screen.getByText(/Add "XL"/);
    fireEvent.mouseDown(row);
    expect(created).toEqual(['XL']);
    expect(value).toBe('XL');
    // The chosen text shows on the closed control even before it is an option.
    rerender(wrap(<SearchSelect value={value} onChange={() => {}} onCreate={() => {}}
        options={[{ value: 'S', label: 'S' }]} placeholder="Pick" allowBlank={false} />));
    expect(screen.getByRole('combobox').textContent).toContain('XL');
  });

  test('does not offer to add a value the list already has', () => {
    render(<LocaleProvider><SearchSelect value="" onChange={() => {}} onCreate={() => {}}
        options={[{ value: 'S', label: 'S' }]} placeholder="Pick" allowBlank={false} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: ' s ' } });
    expect(screen.queryByText(/Add "/)).toBeNull();
  });
});
