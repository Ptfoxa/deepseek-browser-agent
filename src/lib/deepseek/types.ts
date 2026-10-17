export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface ChatCompleter {
  complete(options: CompletionOptions): Promise<CompletionResult>;
}
