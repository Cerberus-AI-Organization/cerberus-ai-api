import { ComputeNode } from '../../types/computeNode';
import { createNodeProvider } from '../providers';

// Ollama default embed model
export const OLLAMA_EMBED_MODEL = 'qwen3-embedding:4b';

// OpenAI embed model — configurable via env var
export const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small';

// Embedding dimension — must match the model in use.
// Default 2560 (qwen3-embedding:4b). Set EMBED_DIM=1536 for text-embedding-3-small,
// or EMBED_DIM=3072 for text-embedding-3-large.
// ⚠️ Changing this requires clearing ./data/vector_db and re-indexing all documents.
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 2560);

export class DocumentEmbedder {
  async embed(text: string, node: ComputeNode): Promise<number[]> {
    const provider = createNodeProvider(node);
    const model = node.api_type === 'openai' ? OPENAI_EMBED_MODEL : OLLAMA_EMBED_MODEL;
    return provider.embed(text, model);
  }
}
