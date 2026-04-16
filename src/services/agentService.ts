import { countTokens, type OllamaMessage, runAIStream } from '../core/aiHelpers';
import { createNodeProvider } from '../core/providers';
import { ComputeNode } from '../types/computeNode';
import { DocumentRow } from '../core/rag/types';
import { Knowledge } from '../core/rag/Knowledge';
import { ToolCall } from 'ollama';
import { encoding_for_model } from 'tiktoken';
import { ToolName } from '../types/constants';
import { getTools, getCurrentDate, webSearch, webFetch } from './toolService';
import { getKnowledge } from './ragService';

type Logger = {
  log: (scope: string, msg: string, data?: unknown) => void;
  warn: (scope: string, msg: string, data?: unknown) => void;
  error: (scope: string, msg: string, err?: unknown) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Context helpers
// ─────────────────────────────────────────────────────────────────────────────

export const truncateRagToFitContext = (
  ragMessage: OllamaMessage,
  availableTokens: number,
  clog: Logger
): OllamaMessage => {
  const truncatedWarning = '\n[RAG truncated due to context limit]';
  const enc = encoding_for_model('gpt-4');
  const encoded = enc.encode(ragMessage.content);
  const truncated = encoded.slice(0, availableTokens - countTokens(truncatedWarning));
  const decoded = new TextDecoder().decode(enc.decode(truncated));

  clog.warn('Stream', `RAG truncated from ${encoded.length} to ${truncated.length} tokens`);
  return { ...ragMessage, content: decoded + truncatedWarning };
};

export const buildMessageContext = (
  systemMessage: OllamaMessage,
  ragMessage: OllamaMessage | null,
  chatHistory: OllamaMessage[],
  userContent: string
): OllamaMessage[] => {
  const messages: OllamaMessage[] = [
    systemMessage,
    ...chatHistory,
    { role: 'user', content: userContent },
  ];
  if (ragMessage) messages.splice(1, 0, ragMessage);
  return messages;
};

// ─────────────────────────────────────────────────────────────────────────────
// Agent loop
// ─────────────────────────────────────────────────────────────────────────────

export const streamAIMessage = async (
  content: string,
  systemMessage: OllamaMessage,
  chatHistory: OllamaMessage[],
  rag: { limit: number; use_advanced: boolean; use_web_search: boolean },
  node: ComputeNode,
  model: string,
  emit: (payload: Record<string, unknown>) => void,
  clog: Logger
): Promise<string> => {
  const MAX_RESPONSE_TOKENS = 1000;
  const MAX_TOOL_ITERATIONS = 10;

  const provider = createNodeProvider(node);

  const neededTools: ToolName[] = [ToolName.GET_CURRENT_DATE];
  if (rag.limit > 0) neededTools.push(ToolName.GET_KNOWLEDGE);
  if (rag.use_web_search && provider.supportsWebSearch()) {
    neededTools.push(ToolName.WEB_SEARCH, ToolName.WEB_FETCH);
  }
  const tools = getTools(neededTools);

  let messages = buildMessageContext(systemMessage, null, chatHistory, content);

  clog.log('Stream', `Starting agent loop — model: ${model}`);

  let finalContent = '';
  let iteration = 0;
  let lastState: string | null = null;
  let completeRag: DocumentRow[] = [];

  // ── Agent loop ─────────────────────────────────────────────────────────────
  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    const isLastIteration = iteration - 1 === MAX_TOOL_ITERATIONS;
    clog.log('Stream', `Agent loop iteration ${iteration}`);

    let thinking = '';
    let content = '';
    const toolCalls: ToolCall[] = [];

    const completeMessagesTexts = messages.map((m) => m.content).join('\n');
    const num_ctx = countTokens(completeMessagesTexts) + MAX_RESPONSE_TOKENS;

    for await (const chunk of runAIStream(node.id, model, messages, {
      think: true,
      num_ctx,
      temperature: 0.4,
      tools: !isLastIteration ? tools : undefined,
    })) {
      if (chunk.thinking) {
        thinking += chunk.thinking;
        emit({ generated_think: chunk.thinking });
      }

      if (chunk.content) {
        content += chunk.content;
        emit({ generated_chunk: chunk.content });
      }

      if (chunk.tool_calls.length) {
        toolCalls.push(...chunk.tool_calls);
      }

      const currentState =
        thinking && !content && !toolCalls.length ? 'thinking' : 'generating';

      if (currentState !== lastState) {
        lastState = currentState;
        emit({ generation_state: currentState });
      }
    }

    if (thinking || content || toolCalls.length) {
      messages.push({ role: 'assistant', thinking, content, tool_calls: toolCalls });
    }

    emit({ generated_think: '\n<end-iteration />\n' });

    // ── No tool calls → model is done ───────────────────────────────────────
    if (toolCalls.length === 0) {
      finalContent = content;
      clog.log('Stream', `No tool calls — agent loop complete after ${iteration} iteration(s)`);
      break;
    }

    // ── Execute tool calls ───────────────────────────────────────────────────
    emit({ generation_state: 'executing_tools' });
    clog.log('Stream', `Executing ${toolCalls.length} tool call(s)`);

    for (const call of toolCalls) {
      if (call.function.name === ToolName.GET_CURRENT_DATE) {
        const result = getCurrentDate();
        messages.push({ role: 'tool', tool_name: call.function.name, content: result });
        clog.log('Stream', `Executed tool call: ${call.function.name} - ${result}`);

      } else if (call.function.name === ToolName.GET_KNOWLEDGE) {
        emit({ generation_state: 'preparing_rag' });
        const args = call.function.arguments as { query: string };
        const result = await getKnowledge(args.query, node, model, rag.limit, rag.use_advanced);
        messages.push({ role: 'tool', tool_name: call.function.name, content: result.rag_formated });

        if (result.rag_results.length > 0) {
          completeRag = [...completeRag, ...result.rag_results];
          completeRag = Knowledge.instance.deduplicateDocumentRows(completeRag);
          emit({ rag_results: completeRag });
        }
        clog.log(
          'Stream',
          `Executed tool call: ${call.function.name} > "${args.query}" - ${
            result.rag_results.flatMap((r) => r.chunks).length
          } chunks with average score ${
            result.rag_results.flatMap((r) => r.chunks).reduce((t, c) => t + c.score, 0) /
            result.rag_results.flatMap((r) => r.chunks).length
          }`
        );
        emit({ generation_state: 'executing_tools' });

      } else if (call.function.name === ToolName.WEB_SEARCH) {
        const args = call.function.arguments as { query: string };
        try {
          const results = await webSearch(args.query, 5, node);
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(results) });
          clog.log('Stream', `Executed tool call: ${call.function.name} > "${args.query}" - ${results.length} results`);
        } catch (err) {
          messages.push({ role: 'tool', tool_name: call.function.name, content: 'Failed to search the web.' });
          clog.error('Stream', `Failed to execute tool call: ${call.function.name} - ${err}`);
        }

      } else if (call.function.name === ToolName.WEB_FETCH) {
        const args = call.function.arguments as { url: string };
        try {
          const result = await webFetch(args.url, node);
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(result) });
          clog.log('Stream', `Executed tool call: ${call.function.name} > "${args.url}" - ${result.title}`);
        } catch (err) {
          messages.push({ role: 'tool', tool_name: call.function.name, content: 'Failed to fetch the web page.' });
          clog.error('Stream', `Failed to execute tool call: ${call.function.name} - ${err}`);
        }

      } else {
        messages.push({ role: 'tool', tool_name: call.function.name, content: 'Unknown tool' });
        clog.warn('Stream', `Unknown tool call: ${call.function.name}`);
      }
    }

    emit({ generation_state: 'generating' });
  }

  if (iteration >= MAX_TOOL_ITERATIONS && !finalContent) {
    clog.warn('Stream', `Agent loop hit max iterations (${MAX_TOOL_ITERATIONS}), using last content`);
    finalContent =
      messages
        .filter((m) => m.role === 'assistant' && m.content)
        .map((m) => m.content)
        .pop() ?? 'Failed to generate a complete response.';
  }

  if (finalContent.trim() === '') {
    clog.warn('Stream', 'Empty response received from model');
    finalContent = 'Failed to generate message content. Please try again later.';
  }

  clog.log('Stream', `Agent loop done — ${finalContent.length} chars, ${iteration} iteration(s)`);
  return finalContent;
};
