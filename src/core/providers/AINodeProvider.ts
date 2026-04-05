import { ComputeNode } from '../../types/computeNode';
import { Tool, ToolCall, WebFetchResponse, WebSearchResult } from 'ollama';
import {OllamaProvider} from "./OllamaProvider";
import {OpenAIProvider} from "./OpenAIProvider";

export type OllamaCompatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
};

export interface RunOptions {
  tools?: Tool[];
  think?: boolean | 'high' | 'medium' | 'low';
  num_ctx?: number;
  temperature?: number;
  num_predict?: number;
}

export interface ChatChunk {
  content: string;
  thinking: string;
  tool_calls: ToolCall[];
  done: boolean;
}

export interface GenerateResponse {
  response: string;
  logprobs?: Array<{ token: string; logprob: number }>;
}

export abstract class AINodeProvider {
  constructor(protected readonly node: ComputeNode) {}

  abstract isOnline(): Promise<boolean>;
  abstract listModels(): Promise<{ name: string; size: number }[]>;
  abstract chatSync(model: string, messages: OllamaCompatMessage[], options: RunOptions): Promise<ChatChunk>;
  abstract chatStream(model: string, messages: OllamaCompatMessage[], options: RunOptions): AsyncGenerator<ChatChunk>;
  abstract embed(text: string, model: string): Promise<number[]>;
  abstract generate(model: string, prompt: string, options: GenerateOptions): Promise<GenerateResponse>;

  // Ollama-only capabilities — default implementations return not-supported
  canManageModels(): boolean { return false; }
  supportsWebSearch(): boolean { return false; }

  async pullModel(_name: string): Promise<AsyncIterable<any>> {
    throw new Error('pullModel not supported for this provider');
  }
  async deleteModel(_name: string): Promise<void> {
    throw new Error('deleteModel not supported for this provider');
  }
  async stopModels(): Promise<void> {
    throw new Error('stopModels not supported for this provider');
  }
  async webSearch(_query: string, _maxResults: number): Promise<WebSearchResult[]> {
    throw new Error('webSearch not supported for this provider');
  }
  async webFetch(_url: string): Promise<WebFetchResponse> {
    throw new Error('webFetch not supported for this provider');
  }
}

export interface GenerateOptions {
  logprobs?: boolean;
  top_logprobs?: number;
  temperature?: number;
  stop?: string[];
  num_predict?: number;
  num_ctx?: number;
  num_gpu?: number;
  think?: boolean;
}