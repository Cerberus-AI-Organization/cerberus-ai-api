import { Request, Response } from 'express';
import { pool } from '../core/database';
import { ComputeNode } from '../types/computeNode';
import net from 'net'; // pro online kontrolu

export async function checkOnline(ip: string, port: number): Promise<'online' | 'offline'> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000); // 2s timeout

        socket
            .connect(port, ip, () => {
                socket.destroy();
                resolve('online');
            })
            .on('error', () => resolve('offline'))
            .on('timeout', () => {
                socket.destroy();
                resolve('offline');
            });
    });
}

export async function refreshNodeStatuses() {
  try {
    const result = await pool.query('SELECT id, hostname, ip, port, status as current_status FROM compute_nodes');
    let statusesChanged = false;

    for (const node of result.rows) {
      const newStatus = await checkOnline(node.ip, node.port);

      if (newStatus !== node.current_status) {
        await pool.query('UPDATE compute_nodes SET status=$1 WHERE id=$2', [
          newStatus,
          node.id,
        ]);
        console.log(`${newStatus == 'online' ? '❇️' : '⚠️'} Node [${node.hostname}] status changed from ${node.current_status} to ${newStatus}`);
        statusesChanged = true;
      }
    }

    if (statusesChanged) {
      console.log(`✅  Compute node status changes detected at ${new Date().toISOString()}`);
    }
  } catch (err) {
    console.error('❌ Error refreshing compute node statuses:', err);
  }
}
// Přidat nový node (jen admin)
export const addComputeNode = async (req: Request, res: Response) => {
    const { hostname, ip, port } = req.body;
    const user = (req as any).user;

    if (user.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can add compute nodes' });
    }

    try {
        const status = await checkOnline(ip, port);
        const result = await pool.query<ComputeNode>(
            `INSERT INTO compute_nodes (hostname, ip, port, added_by, status) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [hostname, ip, port, user.id, status]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error adding compute node' });
    }
};

// Upravit node (jen admin)
export const updateComputeNode = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { hostname, ip, port } = req.body;
    const user = (req as any).user;

    if (user.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can update compute nodes' });
    }

    try {
        const status = await checkOnline(ip, port);
        const result = await pool.query<ComputeNode>(
            `UPDATE compute_nodes 
       SET hostname=$1, ip=$2, port=$3, status=$4
       WHERE id=$5 RETURNING *`,
            [hostname, ip, port, status, id]
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

// Get all nodes – jiný pohled pro admina a usera
export const getComputeNodes = async (req: Request, res: Response) => {
    const user = (req as any).user;

    try {
        if (user.role === 'admin') {
            const result = await pool.query<ComputeNode>('SELECT * FROM compute_nodes');
            return res.json(result.rows);
        } else {
            const result = await pool.query(
                'SELECT id, hostname, status FROM compute_nodes'
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