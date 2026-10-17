export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'low' | 'high' | 'original' | 'auto';
  };
}

export type ChatContentPart = TextContentPart | ImageContentPart;

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface CompletionOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessageInput[];
  timeoutMs: number;
  signal: AbortSignal;
  jsonMode: boolean;
  maxTokens: number;
  temperature?: number;
}

export interface CompletionResult {
  content: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
  };
}

export interface ChatCompleter {
  complete(options: CompletionOptions): Promise<CompletionResult>;
}
