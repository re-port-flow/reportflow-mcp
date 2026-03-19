import axios from 'axios';
import { handleGetDesignParameters } from './get-design-parameters';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('handleGetDesignParameters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env['REPORTFLOW_APP_KEY'] = 'test-app-key';
    process.env['REPORTFLOW_SECRET_KEY'] = 'test-secret-key';
  });

  afterEach(() => {
    delete process.env['REPORTFLOW_APP_KEY'];
    delete process.env['REPORTFLOW_SECRET_KEY'];
  });

  it('正常系: パラメータ構造を返す', async () => {
    const mockData = {
      name: 'string',
      amount: 'number',
      items: [{ itemName: 'string', price: 'number' }],
    };
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockData });

    const result = await handleGetDesignParameters({
      designId: 'test-design-id',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(mockData);
  });

  it('正常系: versionを指定してパラメータ構造を返す', async () => {
    const mockData = { title: 'string' };
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockData });

    const result = await handleGetDesignParameters({
      designId: 'test-design-id',
      version: 2,
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockData);

    const callUrl = (
      (mockedAxios.get as jest.Mock).mock.calls[0] as [string]
    )[0];
    expect(callUrl).toContain('version=2');
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockedAxios.get = jest.fn().mockRejectedValue(new Error('Network Error'));

    const result = await handleGetDesignParameters({
      designId: 'invalid-id',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Network Error');
  });

  it('エラー系: 非Errorオブジェクトのエラーでも文字列化する', async () => {
    mockedAxios.get = jest.fn().mockRejectedValue('unknown error');

    const result = await handleGetDesignParameters({
      designId: 'invalid-id',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー:');
  });
});
