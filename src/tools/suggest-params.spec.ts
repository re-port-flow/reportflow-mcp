jest.mock('../client.js', () => ({
  getDesignParameters: jest.fn(),
}));

import {
  handleSuggestParams,
  parseJsonLoose,
} from './suggest-params.js';
import { getDesignParameters } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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

const makeFakeServer = (createMessage: CreateMessageMock): McpServer =>
  ({
    server: { createMessage },
  }) as unknown as McpServer;

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

  it('wraps Sampling-unsupported errors clearly', async () => {
    mockGet.mockResolvedValueOnce({ amount: 'number' });
    const createMessage: CreateMessageMock = jest.fn().mockRejectedValue(
      new Error('Method not found: sampling/createMessage'),
    );
    const server = makeFakeServer(createMessage);
    const result = await handleSuggestParams(server, {
      designId: 'd1',
      description: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Sampling');
  });
});
