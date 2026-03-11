import {ComputeNode} from "../../types/computeNode";
import {pool} from "../database";
import {createOllamaClientFromNode} from "../ollama";
import {EMBED_MODEL} from "../rag/documentEmbedder";

async function getAvailableNodes(): Promise<ComputeNode[]> {
  const res = await pool.query(
    "SELECT * FROM compute_nodes WHERE status = 'online' ORDER BY priority DESC"
  );
  const nodes = res.rows;
  if (!nodes) throw new Error("No online compute node found");
  return nodes;
}

export async function initNodes() {
  const nodes = await getAvailableNodes();
  console.log(`Found ${nodes.length} online compute nodes`);

  const requiredModels = [
    EMBED_MODEL,
  ];

  let someModelsMissing = false;
  for (const node of nodes) {
    try {
      const ollama = createOllamaClientFromNode(node);
      const models = (await ollama.list()).models.map(m => m.name);

      for (const req_model of requiredModels) {
        if (!models.some(model => model === req_model)) {
          console.log(`Model ${req_model} not found on node ${node.hostname}, pulling...`);
          await ollama.pull({ model: req_model });
          console.log(`Model ${req_model} pulled on node ${node.hostname}`);
        }
      }
    } catch (err) {
      console.error(`❌  Error initializing node ${node.hostname}:`, err);
      someModelsMissing = true;
    }
  }

  console.log(!someModelsMissing ? "✅  Nodes initialized" : "⚠️  Some nodes failed to initialize");
}