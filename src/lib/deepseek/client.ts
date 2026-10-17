import { redactSecrets, safeErrorMessage } from '../security/sanitize';
import type { ChatCompleter, CompletionOptions, CompletionResult } from './types';

export type DeepSeekErrorCode =
  | 'missing_key'
  | 'invalid_base_url'
  | 'invalid_key'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'server'
  | 'bad_request'
  | 'empty_response'
  | 'invalid_response'
  | 'api_error';

export class DeepSeekError extends Error {
  code: DeepSeekErrorCode;
  status?: number;
  retryable: boolean;

  constructor(code: DeepSeekErrorCode, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new DeepSeekError('invalid_base_url', 'API 地址不能为空');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DeepSeekError('invalid_base_url', 'API 地址格式无效');
  }
  if (url.username || url.password) {
    throw new DeepSeekError('invalid_base_url', 'API 地址不能包含用户名或密码');
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const isLocal = localHosts.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new DeepSeekError('invalid_base_url', 'API 地址必须使用 HTTPS（本地调试可使用 localhost）');
  }
  if (url.search || url.hash) {
    throw new DeepSeekError('invalid_base_url', 'API 地址不能包含查询参数或锚点');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function chatEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith('/chat/completions')) return normalized;
  return `${normalized}/chat/completions`;
}

export function hostPermissionPattern(baseUrl: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl));
  // Chrome match patterns do not support port numbers.
  return `${url.protocol}//${url.hostname}/*`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DeepSeekError('cancelled', '请求已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DeepSeekError('cancelled', '请求已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseErrorBody(text: string): string {
  if (!text) return '';
  try {
    const data = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof data.error?.message === 'string') return redactSecrets(data.error.message).slice(0, 300);
  } catch {
    // Ignore malformed body.
  }
  return redactSecrets(text).slice(0, 300);
}

export class DeepSeekClient implements ChatCompleter {
  private fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.fetchImpl = fetchImpl;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    if (!options.apiKey.trim()) {
      throw new DeepSeekError('missing_key', '尚未配置 DeepSeek API Key');
    }
    const endpoint = chatEndpoint(options.baseUrl);
    const body = {
      model: options.model,
      messages: options.messages,
      stream: false,
      max_tokens: options.maxTokens,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    const deadline = Date.now() + options.timeoutMs;
    let attempt = 0;
    let lastError: DeepSeekError | null = null;

    while (attempt < 3) {
      if (options.signal.aborted) {
        throw new DeepSeekError('cancelled', '请求已取消');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new DeepSeekError('timeout', '请求超时，请稍后重试', { retryable: true });
      }
      const attemptController = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, remaining);
      const onOuterAbort = () => attemptController.abort();
      options.signal.addEventListener('abort', onOuterAbort, { once: true });

      try {
        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: attemptController.signal,
        });
        if (!response.ok) {
          const detail = parseErrorBody(await response.text());
          if (response.status === 401 || response.status === 403) {
            throw new DeepSeekError('invalid_key', 'API Key 无效或没有访问权限', {
              status: response.status,
            });
          }
          if (response.status === 429) {
            throw new DeepSeekError('rate_limited', detail || '请求过于频繁，请稍后重试', {
              status: response.status,
              retryable: true,
            });
          }
          if (response.status >= 500) {
            throw new DeepSeekError('server', detail || 'DeepSeek 服务暂时不可用', {
              status: response.status,
              retryable: true,
            });
          }
          if (response.status === 400 || response.status === 422) {
            throw new DeepSeekError('bad_request', detail || '请求参数被拒绝', {
              status: response.status,
            });
          }
          throw new DeepSeekError('api_error', detail || `API 返回 HTTP ${response.status}`, {
            status: response.status,
          });
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new DeepSeekError('empty_response', 'DeepSeek 返回了空内容，请重试', { retryable: true });
        }
        return {
          content,
          usage: data.usage
            ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
              }
            : undefined,
        };
      } catch (error) {
        if (options.signal.aborted) {
          throw new DeepSeekError('cancelled', '请求已取消');
        }
        if (timedOut) {
          lastError = new DeepSeekError('timeout', '请求超时，请稍后重试', { retryable: true });
        } else if (error instanceof DeepSeekError) {
          lastError = error;
        } else {
          lastError = new DeepSeekError(
            'network',
            `网络请求失败：${safeErrorMessage(error)}`,
            { retryable: true },
          );
        }
        if (!lastError.retryable || attempt >= 2) {
          throw lastError;
        }
        const retryAfter = 700 * 2 ** attempt + Math.floor(Math.random() * 250);
        await sleep(Math.min(retryAfter, Math.max(0, deadline - Date.now() - 50)), options.signal);
        attempt += 1;
      } finally {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onOuterAbort);
      }
    }
    throw lastError ?? new DeepSeekError('api_error', '请求失败');
  }
}

export function describeDeepSeekError(error: unknown): string {
  if (error instanceof DeepSeekError) {
    switch (error.code) {
      case 'missing_key':
        return '请先在设置中配置 DeepSeek API Key。';
      case 'invalid_key':
        return 'API Key 无效或没有访问权限，请检查后重试。';
      case 'rate_limited':
        return '请求过于频繁（限流），已重试仍失败，请稍后再试。';
      case 'timeout':
        return '请求超时。可以检查网络或增大超时时间。';
      case 'cancelled':
        return '请求已取消。';
      case 'network':
        return '网络连接失败，请检查网络、代理或 API 地址。';
      case 'invalid_base_url':
        return 'API 地址无效。';
      case 'empty_response':
        return 'DeepSeek 返回为空，请重试。';
      case 'bad_request':
        return '请求参数被 DeepSeek 拒绝，请检查模型名称与配置。';
      case 'server':
        return 'DeepSeek 服务暂时不可用，请稍后重试。';
      default:
        return error.message;
    }
  }
  return safeErrorMessage(error);
}
