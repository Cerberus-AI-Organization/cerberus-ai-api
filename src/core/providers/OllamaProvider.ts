import { Ollama, ToolCall, WebFetchResponse, WebSearchResult } from 'ollama';
import { ComputeNode } from '../../types/computeNode';
import {
  AINodeProvider,
  ChatChunk,
  GenerateOptions,
  GenerateResponse,
  OllamaCompatMessage,
  RunOptions,
} from './AINodeProvider';
import { countTokens, getMaxCtx, roundCtx, truncateMessagesToFit } from '../AIHelpers';

export class OllamaProvider extends AINodeProvider {
  private readonly ollama: Ollama;

  constructor(node: ComputeNode) {
    super(node);
    this.ollama = new Ollama({ host: node.url });
  }

  // ── Capabilities ──────────────────────────────────────────────────────────

  canManageModels(): boolean { return true; }
  supportsWebSearch(): boolean { return true; }

  // ── Online check ──────────────────────────────────────────────────────────

  async isOnline(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.node.url}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Model listing ─────────────────────────────────────────────────────────

  async listModels(): Promise<{ name: string; size: number }[]> {
    const data = await this.ollama.list();
    return data.models.map(m => ({ name: m.name, size: m.size }));
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  private async prepareChat(
    model: string,
    messages: OllamaCompatMessage[],
    options: RunOptions
  ): Promise<{ ctx: number | undefined; keep_alive: number; msgs: OllamaCompatMessage[] }> {
    const keep_alive = Number(process.env.MODEL_KEEPALIVE) || 300;
    const max_ctx = await getMaxCtx(this.node, model);
    const ctx = options.num_ctx ? roundCtx(options.num_ctx, max_ctx) : undefined;

    const neededCtx = messages.reduce((acc, m) => acc + countTokens(m.content), 0);
    console.log(`Ollama ctx: ${ctx} (needed: ${neededCtx} + response) | model: ${model} | node: ${this.node.hostname}`);

    const effectiveMax = ctx ?? max_ctx;
    const msgs = neededCtx > effectiveMax ? truncateMessagesToFit(messages, effectiveMax) : messages;

    if (msgs !== messages) {
      const newTotal = msgs.reduce((acc, m) => acc + countTokens(m.content), 0);
      console.warn(`Messages truncated: ${neededCtx} → ${newTotal} tokens`);
    }

    return { ctx, keep_alive, msgs };
  }

  async chatSync(model: string, messages: OllamaCompatMessage[], options: RunOptions): Promise<ChatChunk> {
    const { ctx, keep_alive, msgs } = await this.prepareChat(model, messages, options);

    const response = await this.ollama.chat({
      model,
      messages: msgs as any,
      keep_alive,
      stream: false,
      think: options.think as any,
      tools: options.tools,
      options: {
        num_ctx: ctx,
        num_gpu: this.node.max_layers_on_gpu,
        temperature: options.temperature,
        num_predict: options.num_predict,
      },
    }).catch(err => {
      console.error('Error running Ollama sync', err);
      throw err;
    });

    return {
      content: response.message?.content ?? '',
      thinking: (response.message as any)?.thinking ?? '',
      tool_calls: response.message?.tool_calls ?? [],
      done: true,
    };
  }

  async *chatStream(model: string, messages: OllamaCompatMessage[], options: RunOptions): AsyncGenerator<ChatChunk> {
    const { ctx, keep_alive, msgs } = await this.prepareChat(model, messages, options);

    const stream = await this.ollama.chat({
      model,
      messages: msgs as any,
      keep_alive,
      stream: true,
      think: options.think as any,
      tools: options.tools,
      options: {
        num_ctx: ctx,
        num_gpu: this.node.max_layers_on_gpu,
        temperature: options.temperature,
        num_predict: options.num_predict,
      },
    }).catch(err => {
      console.error('Error running Ollama stream', err);
      throw err;
    });

    for await (const chunk of stream) {
      yield {
        content: chunk.message?.content ?? '',
        thinking: (chunk.message as any)?.thinking ?? '',
        tool_calls: chunk.message?.tool_calls ?? [],
        done: chunk.done ?? false,
      };
    }
  }

  // ── Embeddings ────────────────────────────────────────────────────────────

  async embed(text: string, model: string): Promise<number[]> {
    const tokens = countTokens(text);
    const buffer = Math.max(250, Math.floor(tokens * 0.1));
    let needed_ctx = tokens + buffer;
    const max_ctx = await getMaxCtx(this.node, model);

    // Ensure model is available
    const models = await this.ollama.list();
    if (!models.models.some(m => m.name === model)) {
      console.log(`Model ${model} not found on node ${this.node.hostname}, pulling...`);
      await this.ollama.pull({ model });
      console.log(`Model ${model} pulled on node ${this.node.hostname}`);
    }

    const errors: string[] = [];
    let remaining_attempts = 3;

    while (remaining_attempts > 0) {
      try {
        const result = await this.ollama.embeddings({
          model,
          prompt: text,
          keep_alive: Number(process.env.MODEL_KEEPALIVE) || 300,
          options: {
            num_ctx: roundCtx(needed_ctx, max_ctx),
            num_gpu: this.node.max_layers_on_gpu,
          },
        });
        return result.embedding;
      } catch (error) {
        if (error instanceof Error) {
          errors.push(error.message);
          if (error.message.includes('input length exceeds the context length')) {
            console.error(`[Embedder] Input length exceeds context length (Needed ${needed_ctx}/Max ${max_ctx}), retrying...`);
            needed_ctx *= 2;
          } else {
            console.error('[Embedder] Error:', error);
          }
        }
        remaining_attempts--;
      }
    }

    throw new Error('Failed to embed after 3 attempts: ' + errors.join(', '));
  }

  // ── Generate (for reranker) ───────────────────────────────────────────────

  async generate(model: string, prompt: string, options: GenerateOptions): Promise<GenerateResponse> {
    const response = await this.ollama.generate({
      model,
      prompt,
      stream: false,
      keep_alive: Number(process.env.MODEL_KEEPALIVE) || 300,
      think: options.think === true ? false : (options.think as any),
      logprobs: options.logprobs,
      options: {
        temperature: options.temperature ?? 0,
        stop: options.stop ?? ['\n'],
        num_predict: options.num_predict ?? 10,
        num_ctx: options.num_ctx,
        num_gpu: options.num_gpu ?? this.node.max_layers_on_gpu,
      },
    }).catch(err => {
      console.error('Error running Ollama generate', err);
      throw err;
    });

    return {
      response: response.response,
      logprobs: (response as any).logprobs ?? undefined,
    };
  }

  // ── Model management ──────────────────────────────────────────────────────

  async pullModel(name: string): Promise<AsyncIterable<any>> {
    return this.ollama.pull({ model: name, stream: true }) as any;
  }

  async deleteModel(name: string): Promise<void> {
    await this.ollama.delete({ model: name });
  }

  async stopModels(): Promise<void> {
    await fetch(`${this.node.url}/api/stop`, { method: 'POST' });
  }

  // ── Web tools ─────────────────────────────────────────────────────────────

  async webSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
    const response = await this.ollama.webSearch({ query, maxResults });
    return response.results;
  }

  async webFetch(url: string): Promise<WebFetchResponse> {
    return this.ollama.webFetch({ url });
  }
}
