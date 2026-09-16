// Adding a variant to a product that already exists. Until this the builder
// was the only way to make one, and only on the day the product was created.
import { describe, test, expect } from 'vitest';
import inventorySrc from '../pages/Inventory.jsx?raw';
import modalSrc from '../pages/inventory/AddVariantModal.jsx?raw';
import clientSrc from '../api/client.js?raw';

describe('the product group row', () => {
  test('offers "Add variant" to someone who may create stock', () => {
    expect(inventorySrc).toMatch(/can\('inventory', 'create'\) && \(\s*<button[^]*?setVariantFor\(pid\)/);
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
  test('offers known values but lets a new one be typed', () => {
    expect(modalSrc).toMatch(/<input className="form-control" list=\{`variant-axis-\$\{a\.name\}`\}/);
    expect(modalSrc).toMatch(/<datalist id=\{`variant-axis-\$\{a\.name\}`\}>/);
  });
  test('leaves price and cost to the siblings unless typed', () => {
    expect(modalSrc).toMatch(/sale_price: form\.sale_price === '' \? null : Number\(form\.sale_price\)/);
    expect(modalSrc).toMatch(/unit_cost: form\.unit_cost === '' \? null : Number\(form\.unit_cost\)/);
    // And does not show cost to someone without the permission.
    expect(modalSrc).toMatch(/\{showCost && \(/);
  });
  test('refuses a duplicate before asking the server', () => {
    expect(modalSrc).toMatch(/const duplicate = preview && siblings\.some/);
    expect(modalSrc).toMatch(/disabled=\{saving \|\| !preview \|\| duplicate\}/);
  });
  test('posts to the variants endpoint', () => {
    expect(clientSrc).toMatch(/addProductVariant\s*=\s*\(id, d\) => api\.post\(`\/api\/products\/\$\{id\}\/variants`, d\)/);
  });
});
