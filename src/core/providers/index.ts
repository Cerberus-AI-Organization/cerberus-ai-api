import { ComputeNode } from '../../types/computeNode';
import { AINodeProvider } from './AINodeProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenAIProvider } from './OpenAIProvider';

export { AINodeProvider } from './AINodeProvider';
export { OllamaProvider } from './OllamaProvider';
export { OpenAIProvider } from './OpenAIProvider';

export function createNodeProvider(node: ComputeNode): AINodeProvider {
  if (node.api_type === 'openai') return new OpenAIProvider(node);
  return new OllamaProvider(node);
}
