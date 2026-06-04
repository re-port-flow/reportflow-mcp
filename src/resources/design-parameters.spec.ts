jest.mock('../client.js', () => ({
  getDesignParameters: jest.fn(),
  listDesigns: jest.fn(),
}));

import {
  readDesignParameters,
  listDesignParameterResources,
} from './design-parameters.js';
import { getDesignParameters, listDesigns } from '../client.js';
import { AuthRequiredError } from '../auth.js';

const mockGet = getDesignParameters as jest.MockedFunction<
  typeof getDesignParameters
>;
const mockList = listDesigns as jest.MockedFunction<typeof listDesigns>;

describe('readDesignParameters', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('returns parameter schema as JSON for the designId from URI', async () => {
    mockGet.mockResolvedValueOnce({ amount: 'number', dueDate: 'date' });
    const uri = new URL('reportflow://designs/abc/parameters');
    const result = await readDesignParameters(uri, { designId: 'abc' });
    expect(mockGet).toHaveBeenCalledWith('abc');
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toEqual({ amount: 'number', dueDate: 'date' });
  });

  it('throws when designId variable missing', async () => {
    await expect(
      readDesignParameters(
        new URL('reportflow://designs//parameters'),
        {} as Record<string, string>,
      ),
    ).rejects.toThrow('designId');
  });
});

describe('listDesignParameterResources', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it('produces one resource entry per design', async () => {
    mockList.mockResolvedValueOnce({
      designs: [
        {
          id: 'd1',
          label: '請求書',
          latestVersion: 2,
          thumbnail: '',
          updatedAt: '',
        },
        {
          id: 'd2',
          label: '見積書',
          latestVersion: 1,
          thumbnail: '',
          updatedAt: '',
        },
      ],
    });
    const result = await listDesignParameterResources();
    expect(result.resources).toHaveLength(2);
    expect(result.resources[0].uri).toEqual(
      'reportflow://designs/d1/parameters',
    );
    expect(result.resources[0].name).toContain('請求書');
    expect(result.resources[0].name).toContain('v2');
  });

  it('returns empty resources when unauthenticated (AuthRequiredError)', async () => {
    mockList.mockRejectedValueOnce(new AuthRequiredError('トークン未保存'));
    const result = await listDesignParameterResources();
    expect(result.resources).toEqual([]);
  });
});
