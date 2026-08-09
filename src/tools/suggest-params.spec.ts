jest.mock('../client.js', () => ({
  getDesignParameters: jest.fn(),
}));

import { handleSuggestParams, parseJsonLoose } from './suggest-params.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDesignParameters } from '../client.js';
const mockGet = getDesignParameters as jest.MockedFunction<
  typeof getDesignParameters
>;

type CreateMessageMock = jest.Mock<
  Promise<{
    model: string;
    role: 'assistant';
    content: { type: 'text'; text: string };
  }>,
  [unknown]
>;

const makeFakeServer = (
  createMessage: CreateMessageMock,
  opts: { sampling?: boolean } = {},
): McpServer => {
  const sampling = opts.sampling ?? true;
  return {
    server: {
      createMessage,
      getClientCapabilities: () => (sampling ? { sampling: {} } : {}),
    },
  } as unknown as McpServer;
};

describe('parseJsonLoose', () => {
  it('parses plain JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips ```json fences', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('extracts embedded object on partial garbage', () => {
    expect(parseJsonLoose('chatter {"a":1} trailing')).toEqual({ a: 1 });
  });
  it('returns null when no object found', () => {
    expect(parseJsonLoose('not json at all')).toBeNull();
  });
});

describe('handleSuggestParams', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('returns parsed params from one-shot sampling', async () => {
    mockGet.mockResolvedValueOnce({ amount: 'number' });
    const createMessage: CreateMessageMock = jest.fn().mockResolvedValueOnce({
      model: 'fake-model',
      role: 'assistant',
      content: { type: 'text', text: '{"amount": 1000}' },
    });
    const server = makeFakeServer(createMessage);
    const result = await handleSuggestParams(server, {
      designId: 'd1',
      description: '合計1000円',
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.params).toEqual({ amount: 1000 });
    expect(parsed.model).toEqual('fake-model');
  });

  it('passes parameter description guidance and schema into the sampling prompt', async () => {
    mockGet.mockResolvedValueOnce({
      amount: {
        name: 'amount',
        type: 'number',
        description: '税込の請求合計額',
      },
    });
    const createMessage: CreateMessageMock = jest.fn().mockResolvedValueOnce({
      model: 'fake-model',
      role: 'assistant',
      content: { type: 'text', text: '{"amount": 1000}' },
    });
    const server = makeFakeServer(createMessage);
    await handleSuggestParams(server, {
      designId: 'd1',
      description: '合計1000円',
    });
    const request = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: { text: string } }>;
    };
    const prompt = request.messages[0].content.text;
    // スキーマの description が AI に届いていること。
    expect(prompt).toContain('税込の請求合計額');
    // description を参照させる指示が含まれていること。
    expect(prompt).toContain('"description"');
    // パラメータ名が "description" でも正当な出力キーとして扱う旨（メタデータ注釈との曖昧さ回避）。
    expect(prompt).toContain('"name" の値が "description"');
  });

  it('self-corrects once when first sample is unparseable', async () => {
    mockGet.mockResolvedValueOnce({ amount: 'number' });
    const createMessage: CreateMessageMock = jest
      .fn()
      .mockResolvedValueOnce({
        model: 'm1',
        role: 'assistant',
        content: { type: 'text', text: 'not json' },
      })
      .mockResolvedValueOnce({
        model: 'm2',
        role: 'assistant',
        content: { type: 'text', text: '{"amount": 5}' },
      });
    const server = makeFakeServer(createMessage);
    const result = await handleSuggestParams(server, {
      designId: 'd1',
      description: 'x',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.params).toEqual({ amount: 5 });
    expect(parsed.retried).toBe(true);
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('returns isError when retry also fails', async () => {
    mockGet.mockResolvedValueOnce({ amount: 'number' });
    const createMessage: CreateMessageMock = jest.fn().mockResolvedValue({
      model: 'm',
      role: 'assistant',
      content: { type: 'text', text: 'still not json' },
    });
    const server = makeFakeServer(createMessage);
    const result = await handleSuggestParams(server, {
      designId: 'd1',
      description: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー');
  });

  it('falls back to schema when client lacks sampling capability', async () => {
    mockGet.mockResolvedValueOnce({ amount: 'number' });
    const createMessage: CreateMessageMock = jest.fn();
    const server = makeFakeServer(createMessage, { sampling: false });
    const result = await handleSuggestParams(server, {
      designId: 'd1',
      description: 'x',
    });
    // No sampling round-trip; schema returned instead of a dead-end error.
    expect(result.isError).toBeUndefined();
    expect(createMessage).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.samplingUnavailable).toBe(true);
    expect(parsed.parameters).toEqual({ amount: 'number' });
  });

  it('falls back to schema when sampling is unsupported at runtime', async () => {
    mockGet.mockResolvedValueOnce({ amount: 'number' });
    const createMessage: CreateMessageMock = jest
      .fn()
      .mockRejectedValue(new Error('Method not found: sampling/createMessage'));
    const server = makeFakeServer(createMessage, { sampling: true });
    const result = await handleSuggestParams(server, {
      designId: 'd1',
      description: 'x',
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.samplingUnavailable).toBe(true);
    expect(parsed.parameters).toEqual({ amount: 'number' });
  });

  it('attempts sampling when getClientCapabilities is unavailable', async () => {
    mockGet.mockResolvedValueOnce({ amount: 'number' });
    const createMessage: CreateMessageMock = jest.fn().mockResolvedValueOnce({
      model: 'fallback-model',
      role: 'assistant',
      content: { type: 'text', text: '{"amount": 7}' },
    });
    // Older SDK / custom server lacking getClientCapabilities must not crash;
    // defer to the sampling attempt (and its SamplingUnsupportedError catch).
    const server = { server: { createMessage } } as unknown as McpServer;
    const result = await handleSuggestParams(server, {
      designId: 'd1',
      description: 'x',
    });
    expect(result.isError).toBeUndefined();
    expect(createMessage).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.params).toEqual({ amount: 7 });
  });
});
