import { pool } from '../database';
import { ComputeNode } from '../../types/computeNode';

export async function getAvailableNode(): Promise<ComputeNode> {
  const res = await pool.query(
    "SELECT * FROM compute_nodes WHERE status = 'online' ORDER BY priority DESC LIMIT 1"
  );
  if (!res.rows[0]) throw new Error('No online compute node found');
  return res.rows[0];
}

export async function getAvailableNodes(): Promise<ComputeNode[]> {
  const res = await pool.query(
    "SELECT * FROM compute_nodes WHERE status = 'online' ORDER BY priority DESC"
  );
  if (!res.rows.length) throw new Error('No online compute nodes found');
  return res.rows;
}
