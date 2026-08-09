import { ERROR_CATALOG, readErrorCatalog } from './error-catalog.js';

describe('readErrorCatalog resource handler', () => {
  it('returns the catalog as pretty-printed JSON at the given uri', () => {
    const uri = new URL('reportflow://errors');
    const result = readErrorCatalog(uri);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe(uri.href);
    expect(result.contents[0].mimeType).toBe('application/json');
    expect(JSON.parse(result.contents[0].text)).toEqual(ERROR_CATALOG);
  });

  it('includes the top-level error groups', () => {
    const parsed = JSON.parse(
      readErrorCatalog(new URL('reportflow://errors')).contents[0].text,
    );
    expect(Object.keys(parsed)).toEqual(['AUTH', 'DESIGN', 'JOB', 'FILE']);
  });
});
