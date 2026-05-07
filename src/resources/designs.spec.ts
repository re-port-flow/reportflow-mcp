jest.mock('../client.js', () => ({
  listDesigns: jest.fn(),
}));

import { readDesigns } from './designs.js';
import { listDesigns } from '../client.js';

const mockListDesigns = listDesigns as jest.MockedFunction<typeof listDesigns>;

describe('readDesigns resource handler', () => {
  beforeEach(() => {
    mockListDesigns.mockReset();
  });

  it('returns JSON of listDesigns at the given uri', async () => {
    mockListDesigns.mockResolvedValueOnce({
      designs: [
        {
          id: 'd1',
          label: '請求書',
          latestVersion: 3,
          thumbnail: 'https://example.test/thumb.png',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const uri = new URL('reportflow://designs');
    const result = await readDesigns(uri);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toEqual(uri.href);
    expect(result.contents[0].mimeType).toEqual('application/json');
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.designs[0].id).toEqual('d1');
  });

  it('propagates errors from listDesigns', async () => {
    mockListDesigns.mockRejectedValueOnce(new Error('boom'));
    await expect(readDesigns(new URL('reportflow://designs'))).rejects.toThrow(
      'boom',
    );
  });
});
