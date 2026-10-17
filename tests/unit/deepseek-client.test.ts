import { describe, expect, it, vi } from 'vitest';
import {
  DeepSeekClient,
  DeepSeekError,
  chatEndpoint,
  normalizeBaseUrl,
} from '../../src/lib/deepseek/client';
import type { CompletionOptions } from '../../src/lib/deepseek/types';

function options(overrides: Partial<CompletionOptions> = {}): CompletionOptions {
  return {
    apiKey: 'test-key-12345678',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'hello' }],
    timeoutMs: 2000,
    signal: new AbortController().signal,
    jsonMode: true,
    maxTokens: 100,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DeepSeek client', () => {
  it('normalizes official and compatible base URLs', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com');
    expect(chatEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(chatEndpoint('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(() => normalizeBaseUrl('http://api.deepseek.com')).toThrow(DeepSeekError);
    expect(() => normalizeBaseUrl('https://user:pass@api.deepseek.com')).toThrow(DeepSeekError);
    expect(normalizeBaseUrl('http://localhost:8787/v1')).toBe('http://localhost:8787/v1');
  });

  it('sends a JSON-mode chat request and returns content', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '{"reply":"ok","plan":null}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const client = new DeepSeekClient(fetchMock as unknown as typeof fetch);
    const result = await client.complete(options());
    expect(result.content).toContain('"reply":"ok"');
    expect(result.usage?.promptTokens).toBe(10);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init?.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toContain('test-key-12345678');
  });

  it('does not retry invalid keys and redacts echoed secrets', async () => {
    const fakeSecret = 'sk-' + 'abcdefghijklmnopqrstuvwxyz012345';
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { message: `bad key ${fakeSecret}` } },
        401,
      ),
    );
    const client = new DeepSeekClient(fetchMock as unknown as typeof fetch);
    await expect(client.complete(options())).rejects.toMatchObject({
      code: 'invalid_key',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    try {
      await client.complete(options());
    } catch (error) {
      expect((error as Error).message).not.toContain('abcdefghijklmnopqrstuvwxyz');
    }
  });

  it('retries rate limits and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }, 429))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'OK' } }] }));
    const client = new DeepSeekClient(fetchMock as unknown as typeof fetch);
    const result = await client.complete(options({ timeoutMs: 5000 }));
    expect(result.content).toBe('OK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports timeouts and user cancellation distinctly', async () => {
    const hangingFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const client = new DeepSeekClient(hangingFetch as unknown as typeof fetch);
    await expect(
      client.complete(options({ timeoutMs: 30 })),
    ).rejects.toMatchObject({ code: 'timeout' });

    const controller = new AbortController();
    const pending = client.complete(
      options({ timeoutMs: 5000, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('maps network failures and non-retryable 400 responses', async () => {
    const networkFetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const networkClient = new DeepSeekClient(networkFetch as unknown as typeof fetch);
    await expect(networkClient.complete(options({ timeoutMs: 5000 }))).rejects.toMatchObject({
      code: 'network',
    });
    expect(networkFetch).toHaveBeenCalledTimes(3);

    const badFetch = vi.fn(async () =>
      jsonResponse({ error: { message: 'invalid request parameters' } }, 400),
    );
    const badClient = new DeepSeekClient(badFetch as unknown as typeof fetch);
    await expect(badClient.complete(options())).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(badFetch).toHaveBeenCalledTimes(1);
  });
});
