import { ModelResponseSchema, type ModelResponse } from '../../types/plan';

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

function tryParseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseModelOutput(content: string): ModelResponse {
  if (!content.trim()) {
    throw new ModelOutputError('模型返回空内容');
  }
  let parsed: unknown;
  try {
    parsed = tryParseJson(content);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ModelOutputError('模型输出不是合法 JSON');
  }
  const result = ModelResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new ModelOutputError('模型输出未通过结构化操作协议校验');
  }
  return result.data;
}
