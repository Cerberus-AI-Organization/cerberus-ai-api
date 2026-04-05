import { countTokens, roundCtx } from '../AIHelpers';
import { ComputeNode } from '../../types/computeNode';
import { DocumentChunk } from './types';
import { createNodeProvider } from '../providers';

export interface RerankedChunk extends DocumentChunk {
  score: number;
}

export class DocumentReranker {
  async rerank(
    query: string,
    chunks: RerankedChunk[],
    node: ComputeNode,
    model: string,
    topK: number
  ): Promise<RerankedChunk[]> {
    const provider = createNodeProvider(node);
    const scoredChunks: RerankedChunk[] = [];

    for (const chunk of chunks) {
      let score = 0;
      let attempts = 0;
      const maxAttempts = 2;

      while (attempts < maxAttempts) {
        const currentPrompt = attempts === 0
          ? `Direct Query: ${query}\nDocument: ${chunk.text}\nIs this document relevant? Answer only Yes or No.`
          : `Relevant? Respond with exactly one word, either "Yes" or "No".\nQuery: ${query}\nDocument: ${chunk.text}`;

        try {
          const response = await provider.generate(model, currentPrompt, {
            temperature: 0,
            stop: ['\n'],
            num_predict: model.includes('cloud') ? undefined : 10,
            num_ctx: roundCtx(countTokens(currentPrompt) + 10, node.max_ctx),
            num_gpu: node.max_layers_on_gpu,
            logprobs: true,
            top_logprobs: 5,
            think: false,
          });

          const logprobs = response.logprobs ?? [];

          if (logprobs.length === 0) {
            score = response.response.trim().toLowerCase().includes('yes') ? chunk.score : 0;
            console.log(`[Reranker]: No logprobs found in response, using score: ${score}`);
            break;
          }

          const index = logprobs.findIndex(
            p => p.token.toLowerCase() === 'yes' || p.token.toLowerCase() === 'no'
          );

          if (index !== -1) {
            const topTokenObj = logprobs[index];
            const tokenText = topTokenObj?.token?.trim().toLowerCase() ?? '';
            const probability = Math.exp(topTokenObj.logprob);
            score = tokenText === 'yes' ? probability : 1 - probability;
            break;
          } else {
            console.log(`[Reranker]: No "Yes" or "No" found in response, retrying...`);
            console.log(`[Reranker]: Response: ${response.response} ${logprobs.map(p => p.token)}`);
          }

          attempts++;

          if (attempts >= maxAttempts) {
            score = response.response.toLowerCase().includes('yes') ? 0.5 : 0;
          }
        } catch (error) {
          console.error(`[Reranker]: Error:`, error);
          score = 0;
          break;
        }
      }

      console.log(`[Reranker]: Final Score for ${chunk.source}-${chunk.page_source}: ${score.toFixed(4)}`);
      scoredChunks.push({ ...chunk, score });
    }

    return scoredChunks
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
