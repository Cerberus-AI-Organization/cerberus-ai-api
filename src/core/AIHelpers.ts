import { Tool, ToolCall } from 'ollama';
import { ComputeNode } from '../types/computeNode';
import { encoding_for_model } from 'tiktoken';
import { createNodeProvider } from './providers';
import { getNodeById } from '../controllers/modelController';
import { OllamaCompatMessage, RunOptions } from './providers/AINodeProvider';

// Re-export types used by controllers / RAG
export type OllamaMessage = OllamaCompatMessage;
export type { Tool, ToolCall };

// ── Token utilities ───────────────────────────────────────────────────────────

export function countTokens(text: string): number {
  const enc = encoding_for_model('gpt-4');
  return enc.encode(text).length;
}

export function roundCtx(ctx: number, maxValue: number): number {
  if (ctx <= 0) return 0;
  const rounded = Math.pow(2, Math.ceil(Math.log2(ctx)));
  return Math.min(rounded, maxValue);
}

export function truncateMessagesToFit(messages: OllamaCompatMessage[], maxCtx: number): OllamaCompatMessage[] {
  const result = messages.map(m => ({ ...m }));

  while (true) {
    const totalTokens = result.reduce((acc, msg) => acc + countTokens(msg.content), 0);
    if (totalTokens <= maxCtx) break;

    const overflow = totalTokens - maxCtx;

    let longestIdx = -1;
    let longestTokens = 0;
    for (let i = 0; i < result.length; i++) {
      if (result[i].role === 'system') continue;
      const tokens = countTokens(result[i].content);
      if (tokens > longestTokens) {
        longestTokens = tokens;
        longestIdx = i;
      }
    }

    if (longestIdx === -1) break;

    const enc = encoding_for_model('gpt-4');
    const encoded = enc.encode(result[longestIdx].content);
    const trimCount = Math.min(overflow + 50, encoded.length);
    const trimmed = encoded.slice(trimCount);
    result[longestIdx] = {
      ...result[longestIdx],
      content: new TextDecoder().decode(enc.decode(trimmed)),
    };

    if (!result[longestIdx].content.trim()) {
      result.splice(longestIdx, 1);
    } else {
      result[longestIdx].content += '[Message truncated because of context limit exceeded.]';
    }
  }

  return result;
}

// ── Context window helpers ────────────────────────────────────────────────────

export async function getModelsMaxCtx(model: string): Promise<number | null> {
  try {
    const baseModel = model.split(':')[0];
    const url = `https://ollama.com/library/${baseModel}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const html = await res.text();
    const match = html.match(/(\d+(?:\.\d+)?)([KMB]?)\s*context window/i);
    if (!match) return null;

    let value = parseFloat(match[1]);
    const unit = match[2]?.toUpperCase();
    if (unit === 'K') value *= 1024;
    if (unit === 'M') value *= 1024 * 1024;
    if (unit === 'B') value *= 1024 * 1024 * 1024;

    return Math.round(value);
  } catch (error) {
    console.error(`Error fetching model ctx for ${model}:`, error);
    return null;
  }
}

export async function getMaxCtx(node: ComputeNode, model: string): Promise<number> {
  let maxCtx = null;
  if (node.api_type === 'ollama')
    maxCtx = await getModelsMaxCtx(model)

  if (!maxCtx) return node.max_ctx;
  if (model.includes('cloud')) return maxCtx;
  return Math.min(maxCtx, node.max_ctx);
}

// ── runAISync / runAIStream ───────────────────────────────────────────
export async function runAISync(
  nodeId: number,
  model: string,
  messages: OllamaCompatMessage[],
  options: RunOptions = {}
): Promise<{ content: string; thinking: string; tool_calls: ToolCall[]; done: boolean }> {
  const node = await getNodeById(nodeId);
  const provider = createNodeProvider(node);

  if (!(await provider.isOnline())) {
    throw new Error('Node is offline');
  }

  return provider.chatSync(model, messages, options);
}

export async function* runAIStream(
  nodeId: number,
  model: string,
  messages: OllamaCompatMessage[],
  options: RunOptions = {}
): AsyncGenerator<{ content: string; thinking: string; tool_calls: ToolCall[]; done: boolean }> {
  const node = await getNodeById(nodeId);
  const provider = createNodeProvider(node);

  if (!(await provider.isOnline())) {
    throw new Error('Node is offline');
  }

  yield* provider.chatStream(model, messages, options);
}
