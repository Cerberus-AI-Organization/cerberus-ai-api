import {countTokens, createOllamaClientFromNode, getMaxCtx, haveModel, roundCtx} from "../ollama";
import { ComputeNode } from "../../types/computeNode";

export const EMBED_MODEL = "qwen3-embedding:4b";
export const EMBED_DIM = 2560;

export class DocumentEmbedder {
  async embed(text: string, node: ComputeNode): Promise<number[]> {
    const ollama = createOllamaClientFromNode(node);

    if (!(await haveModel(node, EMBED_MODEL))) {
      console.log(`Model ${EMBED_MODEL} not found on node ${node.hostname}, pulling...`);
      await ollama.pull({ model: EMBED_MODEL });
      console.log(`Model ${EMBED_MODEL} pulled on node ${node.hostname}`);
    }

    const tokens = countTokens(text);
    const buffer = Math.max(250, Math.floor(tokens * 0.1));
    let needed_ctx = tokens + buffer;
    const max_ctx = await getMaxCtx(node, EMBED_MODEL);

    let errors = []

    let remaining_attempts = 3;
    while (remaining_attempts > 0) {
      try {
        const result = await ollama.embeddings({
          model: EMBED_MODEL,
          prompt: text,
          keep_alive: Number(process.env.MODEL_KEEPALIVE) || 300,
          options: {
            num_ctx: roundCtx(needed_ctx, max_ctx),
            num_gpu: node.max_layers_on_gpu,
          }
        });

        return result.embedding;
      } catch (error) {
        if (error instanceof Error) {
          errors.push(error.message);

          if (error.message.includes("input length exceeds the context length")) {
            console.error(`[Embedder] Input length exceeds context length (Needed ${needed_ctx}/Max ${max_ctx}), retrying...`);
            needed_ctx *= 2
          } else {
            console.error("[Embedder] Error: ", error);
          }
        }
        remaining_attempts--;
      }
    }

    throw new Error("Failed to embed document after 3 attempts: " + errors.join(", "));
  }
}