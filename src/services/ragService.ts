import { countTokens, type OllamaMessage, runAISync } from '../core/aiHelpers';
import { Knowledge } from '../core/rag/Knowledge';
import { ComputeNode } from '../types/computeNode';
import { DocumentRow } from '../core/rag/types';
import { stripThinkTags } from './chatService';

// ─────────────────────────────────────────────────────────────────────────────
// RAG query generation
// ─────────────────────────────────────────────────────────────────────────────

const extractSearchQueries = (content: string): string[] => {
  const matches = [...content.matchAll(/<query>([\s\S]*?)<\/query>/gi)];
  return matches.length > 0
    ? matches.map((m) => m[1].trim()).filter(Boolean)
    : [content.trim()];
};

export const generateRagQueries = async (
  chatMessages: OllamaMessage[],
  node: ComputeNode,
  model: string,
  clog: { log: (s: string, m: string, d?: unknown) => void; warn: (s: string, m: string, d?: unknown) => void; error: (s: string, m: string, e?: unknown) => void }
): Promise<string[]> => {
  const context = chatMessages
    .slice(-3)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const messages: OllamaMessage[] = [
    {
      role: 'system',
      content: `You generate semantic search queries for a vector database.

Rules:
- Focus mainly on the LAST user message.
- Use previous messages only if necessary.
- Queries should be natural language search phrases.
- Include important technologies, entities, and concepts.
- Avoid conversational filler.
- Prefer semantic clarity over short keywords.

Decide query count:
- Simple question → 1 query
- Complex question → up to 3 queries

Return strictly in XML:
<queries>
  <query>text</query>
</queries>

Do not output anything outside the XML.`,
    },
    { role: 'user', content: `Messages for summary: ${context}` },
  ];

  const num_ctx = countTokens(messages.map((m) => m.content).join('\n')) + 512;
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await runAISync(node.id, model, messages, {
      think: 'medium',
      num_ctx,
    }).catch((err) => {
      clog.error('RAG', `Query generation attempt ${attempt} failed`, err);
      return { content: '', done: true };
    });

    const queries = extractSearchQueries(stripThinkTags(response.content.trim()));
    if (queries.length > 0 && queries.every((q) => q.length > 0)) {
      clog.log('RAG', `Generated ${queries.length} search quer${queries.length > 1 ? 'ies' : 'y'}`, queries);
      return queries;
    }

    clog.warn('RAG', `Attempt ${attempt}/${MAX_RETRIES} produced invalid queries, retrying...`);
  }

  throw new Error('Failed to generate RAG queries after multiple attempts');
};

// ─────────────────────────────────────────────────────────────────────────────
// RAG result processing
// ─────────────────────────────────────────────────────────────────────────────

export const filterRagResults = (results: DocumentRow[]): DocumentRow[] => {
  return results
    .map((doc) => ({
      ...doc,
      chunks: doc.chunks.filter((chunk) => chunk.score >= 0.5),
    }))
    .filter((doc) => doc.chunks.length > 0);
};

export const formatRagResults = (results: DocumentRow[]): string => {
  return results
    .flatMap((doc) =>
      doc.chunks.map((chunk) => {
        const structure = chunk.text
          .substring(chunk.text.indexOf('STRUCTURE: ') + 'STRUCTURE: '.length, chunk.text.indexOf('TEXT: '))
          .trim();
        const text = chunk.text
          .substring(chunk.text.indexOf('TEXT: ') + 'TEXT: '.length)
          .trim();
        return `---\nSOURCE: ${doc.source} (PAGE: ${chunk.page_source})\nSTRUCTURE: ${structure}\nTEXT: ${text}\n---`;
      })
    )
    .join('\n\n');
};

export const getRag = async (
  chatMessages: OllamaMessage[],
  limit: number,
  use_advanced_rag: boolean,
  node: ComputeNode,
  model: string,
  clog: { log: (s: string, m: string, d?: unknown) => void; warn: (s: string, m: string, d?: unknown) => void; error: (s: string, m: string, e?: unknown) => void }
): Promise<{ rag_results: DocumentRow[]; rag_formated: string }> => {
  const queries = await generateRagQueries(chatMessages, node, model, clog);
  const knowledge = Knowledge.instance;

  const rawResults = await Promise.all(
    queries.map((q) =>
      use_advanced_rag
        ? knowledge.searchWithRerank(q, node, model, limit * 2, limit)
        : knowledge.search(q, node, limit)
    )
  );

  const deduped = knowledge.deduplicateDocumentRows(rawResults.flat());
  const filtered = filterRagResults(deduped);
  const totalChunks = filtered.flatMap((d) => d.chunks).length;

  clog.log('RAG', `Results — raw: ${rawResults.flat().length}, after dedup+filter: ${totalChunks} chunks`);

  return {
    rag_results: filtered,
    rag_formated: formatRagResults(filtered),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge tool (single-query variant used by agent loop)
// ─────────────────────────────────────────────────────────────────────────────

export const getKnowledge = async (
  query: string,
  node: ComputeNode,
  model: string,
  limit: number,
  advanced: boolean
): Promise<{ rag_results: DocumentRow[]; rag_formated: string }> => {
  const knowledge = Knowledge.instance;

  const results = advanced
    ? await knowledge.searchWithRerank(query, node, model, limit * 2, limit)
    : await knowledge.search(query, node, limit);

  const filtered = filterRagResults(results);
  const formatted = formatRagResults(filtered);

  if (!formatted) {
    return { rag_results: [], rag_formated: 'No relevant documents found for the given query.' };
  }

  return { rag_results: filtered, rag_formated: formatted };
};
