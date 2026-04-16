import { Request, Response, NextFunction } from 'express';
import { ComputeNode } from '../types/computeNode';
import { AINodeProvider } from '../core/providers/AINodeProvider';
import { getNodeById, checkNodeOnline } from '../controllers/computeNodeController';
import { createNodeProvider } from '../core/providers';

export interface ResolvedNode {
  node: ComputeNode;
  provider: AINodeProvider;
}

export async function resolveNode(nodeId: number): Promise<ResolvedNode> {
  const node = await getNodeById(nodeId);
  const status = await checkNodeOnline(node);
  if (status === 'offline') {
    throw new Error(`Node #${nodeId} (${node.url}) is offline`);
  }
  const provider = createNodeProvider(node);
  return { node, provider };
}

export const resolveNodeMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { node, provider } = await resolveNode(Number(req.params.id));
    req.resolvedNode = node;
    req.nodeProvider = provider;
    next();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
