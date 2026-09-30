// An unset filter must not reach the server as the word "undefined".
import { describe, test, expect } from 'vitest';
import { _qs } from '../api/client';

describe('the query-string builder', () => {
  test('leaves out undefined and null instead of sending them as words', () => {
    // The invoice export sends every filter, set or not.
    expect(_qs({ status: undefined, client_id: undefined, project_id: null })).toBe('');
    expect(_qs({ client_id: 7, project_id: undefined })).toBe('?client_id=7');
  });
  test('keeps real values, zero and empty text included', () => {
    expect(_qs({ page: 0, search: '' })).toBe('?page=0&search=');
    expect(_qs({ a: 'x y' })).toBe('?a=x+y');
    expect(_qs()).toBe('');
  });
});
