jest.mock('../auth.js', () => ({
  authorize: jest.fn(),
}));

import { authorize } from '../auth.js';
import { handleAuthenticate } from './authenticate.js';

const mockAuthorize = authorize as jest.MockedFunction<typeof authorize>;

describe('handleAuthenticate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns success message with scope and workspace on successful auth', async () => {
    mockAuthorize.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      scope: 'openid profile designs:read',
      expiresAt: Date.now() + 3600_000,
    });
    const result = await handleAuthenticate({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('認証完了');
    expect(result.content[0].text).toContain('openid profile designs:read');
    expect(result.content[0].text).toContain('workspace_id: ws-1');
  });

  it('omits workspace_id line when not present in response', async () => {
    mockAuthorize.mockResolvedValueOnce({
      scope: 'openid',
      expiresAt: Date.now() + 60_000,
    });
    const result = await handleAuthenticate({});
    expect(result.content[0].text).not.toContain('workspace_id');
  });

  it('passes force flag to authorize', async () => {
    mockAuthorize.mockResolvedValueOnce({
      scope: 'openid',
      expiresAt: Date.now() + 1000,
    });
    await handleAuthenticate({ force: true });
    expect(mockAuthorize).toHaveBeenCalledWith({ force: true });
  });

  it('defaults force to false when not provided', async () => {
    mockAuthorize.mockResolvedValueOnce({
      scope: 'openid',
      expiresAt: Date.now() + 1000,
    });
    await handleAuthenticate({});
    expect(mockAuthorize).toHaveBeenCalledWith({ force: false });
  });

  it('returns isError when authorize throws', async () => {
    mockAuthorize.mockRejectedValueOnce(new Error('callback timeout'));
    const result = await handleAuthenticate({});
    expect(result.isError).toEqual(true);
    expect(result.content[0].text).toContain('認証失敗');
    expect(result.content[0].text).toContain('callback timeout');
  });
});
