import { createNodeProvider } from '../providers';
import { OLLAMA_EMBED_MODEL } from '../rag/DocumentEmbedder';
import { getAvailableNodes } from '../repositories/nodeRepository';

export async function initNodes() {
  const nodes = await getAvailableNodes();
  console.log(`Found ${nodes.length} online compute nodes`);

  let someModelsMissing = false;
  for (const node of nodes) {
    const provider = createNodeProvider(node);

    // Model pre-pull only makes sense for Ollama nodes
    if (!provider.canManageModels()) {
      console.log(`Node ${node.hostname} (${node.api_type}) — skipping model check`);
      continue;
    }

    try {
      const models = (await provider.listModels()).map(m => m.name);

      for (const requiredModel of [OLLAMA_EMBED_MODEL]) {
        if (!models.some(m => m === requiredModel)) {
          console.log(`Model ${requiredModel} not found on node ${node.hostname}, pulling...`);
          const stream = await provider.pullModel(requiredModel);
          for await (const _chunk of stream) { /* drain stream */ }
          console.log(`Model ${requiredModel} pulled on node ${node.hostname}`);
        }
      }
    } catch (err) {
      console.error(`❌  Error initializing node ${node.hostname}:`, err);
      someModelsMissing = true;
    }
  }

  console.log(!someModelsMissing ? '✅  Nodes initialized' : '⚠️  Some nodes failed to initialize');
}
