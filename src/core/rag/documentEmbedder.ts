import {countTokens, createOllamaClientFromNode, haveModel, roundCtx} from "../ollama";
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

    const result = await ollama.embeddings({
      model: EMBED_MODEL,
      prompt: text,
      keep_alive: Number(process.env.MODEL_KEEPALIVE) || 300,
      options: {
        num_ctx: roundCtx(countTokens(text) + 250, node.max_ctx),
        num_gpu: node.max_layers_on_gpu,
      }
    });
    return result.embedding;
  }
}