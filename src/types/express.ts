import { ComputeNode } from './computeNode';
import { AINodeProvider } from '../core/providers/AINodeProvider';

declare global {
  namespace Express {
    interface Request {
      user: { id: number; role: string };
      resolvedNode: ComputeNode;
      nodeProvider: AINodeProvider;
    }
  }
}
