import OpenAI from 'openai';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { ToolCall, WebFetchResponse, WebSearchResult } from 'ollama';
import { ComputeNode } from '../../types/computeNode';
import {
  AINodeProvider,
  ChatChunk,
  GenerateOptions,
  GenerateResponse,
  OllamaCompatMessage,
  RunOptions,
} from './AINodeProvider';
import { cleanMarkdown } from '../rag/tools/markdownUtils';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// ── Message format conversion ─────────────────────────────────────────────────
// Ollama uses tool_name on tool-result messages and stores tool_call ids in
// ToolCall.  OpenAI requires tool_call_id on tool-result messages.
// We carry a map of functionName → tool_call_id to bridge the two formats.

function toOpenAIMessages(
  messages: OllamaCompatMessage[]
): { msgs: OpenAI.ChatCompletionMessageParam[]; toolCallIdMap: Map<string, string> } {
  const toolCallIdMap = new Map<string, string>();
  const msgs: OpenAI.ChatCompletionMessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      msgs.push({ role: m.role, content: m.content });

    } else if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const openaiToolCalls: OpenAI.ChatCompletionMessageToolCall[] = m.tool_calls.map(tc => {
          const id = (tc as any).id ?? `call_${tc.function.name}_${Date.now()}`;
          toolCallIdMap.set(tc.function.name, id);
          return {
            id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            },
          };
        });
        msgs.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: openaiToolCalls,
        });
      } else {
        msgs.push({ role: 'assistant', content: m.content });
      }

    } else if (m.role === 'tool') {
      const callId = toolCallIdMap.get(m.tool_name ?? '') ?? `call_${m.tool_name}_fallback`;
      msgs.push({
        role: 'tool',
        tool_call_id: callId,
        content: m.content,
      });
    }
  }

  return { msgs, toolCallIdMap };
}

function toOpenAITools(tools: RunOptions['tools']): OpenAI.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.function?.name ?? '',
      description: t.function?.description ?? '',
      parameters: (t.function?.parameters ?? {}) as Record<string, unknown>,
    },
  }));
}

function normalizeOpenAIToolCalls(
  calls: OpenAI.ChatCompletionMessageToolCall[] | null | undefined
): ToolCall[] {
  if (!calls) return [];
  return calls
    .filter((c): c is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => c.type === 'function')
    .map(c => ({
      id: c.id,
      function: {
        name: (c as any).function.name,
        arguments: (() => {
          try { return JSON.parse((c as any).function.arguments); } catch { return {}; }
        })(),
      },
    } as any));
}

// ── OpenAIProvider ────────────────────────────────────────────────────────────

export class OpenAIProvider extends AINodeProvider {
  private readonly client: OpenAI;

  constructor(node: ComputeNode) {
    super(node);
    this.client = new OpenAI({
      baseURL: node.url,
      apiKey: node.api_key ?? 'no-key',
    });
  }

  // ── Capabilities ──────────────────────────────────────────────────────────

  canManageModels(): boolean { return false; }
  supportsWebSearch(): boolean { return !!process.env.BRAVE_SEARCH_API_KEY; }

  // ── Online check ──────────────────────────────────────────────────────────

  async isOnline(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.node.url}/models`, {
        headers: { Authorization: `Bearer ${this.node.api_key ?? ''}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Model listing ─────────────────────────────────────────────────────────

  async listModels(): Promise<{ name: string; size: number }[]> {
    const data = await this.client.models.list();
    return data.data
      .filter(m => !m.id.toLowerCase().includes('embed'))
      .map(m => ({ name: m.id, size: 0 }));
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  async chatSync(model: string, messages: OllamaCompatMessage[], options: RunOptions): Promise<ChatChunk> {
    const { msgs } = toOpenAIMessages(messages);

    const response = await this.client.chat.completions.create({
      model,
      messages: msgs,
      stream: false,
      tools: toOpenAITools(options.tools),
      max_completion_tokens: options.num_predict,
      temperature: options.temperature,
    });

    const choice = response.choices[0];
    return {
      content: choice.message.content ?? '',
      thinking: (choice.message as any).reasoning ?? '',
      tool_calls: normalizeOpenAIToolCalls(choice.message.tool_calls),
      done: true,
    };
  }

  async *chatStream(model: string, messages: OllamaCompatMessage[], options: RunOptions): AsyncGenerator<ChatChunk> {
    const { msgs } = toOpenAIMessages(messages);

    const stream = await this.client.chat.completions.create({
      model,
      messages: msgs,
      stream: true,
      tools: toOpenAITools(options.tools),
      max_completion_tokens: options.num_predict,
      temperature: options.temperature,
    });

    const accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      const done = chunk.choices[0]?.finish_reason != null;

      // Accumulate tool call deltas
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!accumulatedToolCalls.has(idx)) {
            accumulatedToolCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' });
          }
          const acc = accumulatedToolCalls.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }

      // Emit tool calls only on final chunk
      const toolCalls: ToolCall[] = [];
      if (done && accumulatedToolCalls.size > 0) {
        for (const acc of accumulatedToolCalls.values()) {
          toolCalls.push({
            id: acc.id,
            function: {
              name: acc.name,
              arguments: (() => {
                try { return JSON.parse(acc.arguments); } catch { return {}; }
              })(),
            },
          } as any);
        }
      }

      yield {
        content: delta?.content ?? '',
        thinking: (delta as any)?.reasoning ?? '',
        tool_calls: toolCalls,
        done,
      };
    }
  }

  // ── Embeddings ────────────────────────────────────────────────────────────

  async embed(text: string, model: string): Promise<number[]> {
    const response = await this.client.embeddings.create({ model, input: text });
    return response.data[0].embedding;
  }

  // ── Web tools ─────────────────────────────────────────────────────────────

  async webSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY is not set');

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));

    const res = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!res.ok) throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`);

    const data = await res.json() as any;
    const results: any[] = data?.web?.results ?? [];

    return results.map(r => ({
      content: `Title: ${r.title ?? ''}\nURL: ${r.url ?? ''}\nDescription: ${r.description ?? ''}`,
    }));
  }

  async webFetch(url: string): Promise<WebFetchResponse> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`webFetch error: ${res.status} ${res.statusText}`);

    const html = await res.text();
    const $ = cheerio.load(html);

    const title = $('title').text().trim();

    const links: string[] = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const abs = new URL(href, url);
        if (abs.protocol.startsWith('http')) links.push(abs.toString());
      } catch {}
    });

    const main = $('main').length ? $('main') : $('article').length ? $('article') : $('body');
    const cleanHtml = main.clone();
    cleanHtml.find('script, style, nav, footer, header, aside, noscript, svg, img, form, button').remove();

    let content = turndown.turndown(cleanHtml.html() || '');
    content = cleanMarkdown(content);

    return { title, url, content, links };
  }

  // ── Generate (for reranker) ───────────────────────────────────────────────

  async generate(model: string, prompt: string, options: GenerateOptions): Promise<GenerateResponse> {
    const response = await this.client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: options.num_predict ?? 10,
      temperature: options.temperature ?? 0,
      logprobs: options.logprobs,
      top_logprobs: options.logprobs ? (options.top_logprobs ?? 5) : undefined,
    });

    const choice = response.choices[0];
    const text = choice.message.content ?? '';

    // Normalize logprobs to same shape as Ollama's: Array<{ token, logprob }>
    const logprobs = choice.logprobs?.content
      ?.flatMap(lp => [
        { token: lp.token, logprob: lp.logprob },
        ...(lp.top_logprobs ?? []).map(tl => ({ token: tl.token, logprob: tl.logprob })),
      ]);

    return { response: text, logprobs };
  }
}
