import { Request, Response } from 'express';
import { pool } from '../core/database';
import { ComputeNode } from '../types/computeNode';
import { createNodeProvider } from '../core/providers';
import { initKnowledge } from '../core/init/initKnowledge';

export async function getNodeById(id: number): Promise<ComputeNode> {
  const result = await pool.query('SELECT * FROM compute_nodes WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    throw new Error('Compute node not found');
  }
  return result.rows[0];
}

export async function checkNodeOnline(node: ComputeNode): Promise<'online' | 'offline'> {
  const provider = createNodeProvider(node);
  return (await provider.isOnline()) ? 'online' : 'offline';
}

export async function refreshNodeStatuses(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT * FROM compute_nodes');
    let statusesChanged = false;

    for (const node of result.rows as ComputeNode[]) {
      const newStatus = await checkNodeOnline(node);

      if (newStatus !== node.status) {
        await pool.query('UPDATE compute_nodes SET status=$1 WHERE id=$2', [newStatus, node.id]);
        console.log(`${newStatus === 'online' ? '❇️' : '⚠️'} Node [${node.hostname}] status changed from ${node.status} to ${newStatus}`);
        statusesChanged = true;
      }
    }

    if (statusesChanged) {
      console.log(`✅  Compute node status changes detected at ${new Date().toISOString()}`);
    }
    return statusesChanged;
  } catch (err) {
    console.error('❌ Error refreshing compute node statuses:', err);
    return false;
  }
}

export const addComputeNode = async (req: Request, res: Response) => {
  const { hostname, url, api_type = 'ollama', api_key, priority, max_ctx, max_layers_on_gpu } = req.body;
  const user = (req as any).user;

  if (user.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can add compute nodes' });
  }

  try {
    // Build a temporary node object for the online check
    const tempNode: ComputeNode = {
      id: 0,
      hostname,
      url,
      api_type: api_type as 'ollama' | 'openai',
      api_key: api_key ?? null,
      priority: priority ?? 0,
      max_ctx: max_ctx ?? 4096,
      max_layers_on_gpu: max_layers_on_gpu ?? -1,
      added_by: null,
      status: 'offline',
      created_at: new Date(),
    };

    const status = await checkNodeOnline(tempNode);
    if (status === 'offline') {
      throw new Error('Node is offline');
    }

    const result = await pool.query<ComputeNode>(
      `INSERT INTO compute_nodes (hostname, url, api_type, api_key, priority, max_ctx, max_layers_on_gpu, added_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [tempNode.hostname, tempNode.url,
       tempNode.api_type, tempNode.api_key,
       tempNode.priority, tempNode.max_ctx,
       tempNode.max_layers_on_gpu, user.id, status]
    );

    await initKnowledge();

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error adding compute node' });
  }
};

export const updateComputeNode = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { hostname, url, api_type, api_key } = req.body;
  const user = (req as any).user;

  if (user.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can update compute nodes' });
  }

  try {
    const tempNode: ComputeNode = {
      id: Number(id),
      hostname,
      url,
      api_type: (api_type ?? 'ollama') as 'ollama' | 'openai',
      api_key: api_key ?? null,
      priority: 0,
      max_ctx: 4096,
      max_layers_on_gpu: -1,
      added_by: null,
      status: 'offline',
      created_at: new Date(),
    };

    const status = await checkNodeOnline(tempNode);

    const result = await pool.query<ComputeNode>(
      `UPDATE compute_nodes
       SET hostname=$1, url=$2, api_type=$3, api_key=$4, status=$5
       WHERE id=$6 RETURNING *`,
      [hostname, url, api_type ?? 'ollama', api_key ?? null, status, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Compute node not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error updating compute node' });
  }
};

export const getComputeNodes = async (req: Request, res: Response) => {
  const user = (req as any).user;

  try {
    if (user.role === 'admin') {
      const result = await pool.query<ComputeNode>('SELECT * FROM compute_nodes');
      return res.json(result.rows);
    } else {
      const result = await pool.query(
        'SELECT id, hostname, status, priority, api_type FROM compute_nodes'
      );
      return res.json(result.rows);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching compute nodes' });
  }
};

export const deleteComputeNode = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;

  if (user.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can delete compute nodes' });
  }

  try {
    const result = await pool.query('DELETE FROM compute_nodes WHERE id=$1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Compute node not found' });
    }
    res.json({ message: 'Compute node deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error deleting compute node' });
  }
};
