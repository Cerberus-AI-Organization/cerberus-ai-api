import { Request, Response } from 'express';
import fetch from 'node-fetch';
import { pool } from '../core/database';
import {ComputeNode} from "../types/computeNode";
import {checkOnline} from "./computeNodeController";
import {runOllamaStream, runOllamaSync} from "../core/ollama";

export async function getNodeById(id: number) {
    const result = await pool.query('SELECT * FROM compute_nodes WHERE id = $1', [id]);
    if (result.rows.length === 0) {
        throw new Error('Compute node not found');
    }
    return result.rows[0];
}

export function buildOllamaUrl(node: ComputeNode) {
    if (node.ip.includes("http://") || node.ip.includes("https://")) {
        return `${node.ip}:${node.port}`;
    }
    return `http://${node.ip}:${node.port}`;
}

export const listModels = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const node = await getNodeById(Number(id));
        const status = await checkOnline(node.ip, node.port);
        if (status === 'offline') {
            return res.status(500).json({ error: "Node is offline" });
        }

        const resp = await fetch(`${buildOllamaUrl(node)}/api/tags`);
        const data = await resp.json() as { models?: any[] };

        res.json(data.models?.map((model: any) => ({
          name: model.name,
          size: model.size
        })));
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const pullModel = async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    if (currentUser.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can pull ollama models' });
    }

    try {
        const { id } = req.params;
        const { name } = req.body;
        const node = await getNodeById(Number(id));

        const status = await checkOnline(node.ip, node.port);
        if (status === 'offline') {
            return res.status(500).json({ error: "Node is offline" });
        }

        const resp = await fetch(`${buildOllamaUrl(node)}/api/pull`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name })
        });

        if (!resp.body) {
            return res.status(500).json({ error: "No response body from ollama" });
        }

        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Transfer-Encoding", "chunked");

        let buffer = "";

        resp.body.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.trim()) {
                    res.write(line + "\n");
                }
            }
        });

        resp.body.on("end", () => {
            if (buffer.trim()) {
                res.write(buffer + "\n");
            }
            res.end();
        });

        resp.body.on("error", (err: Error) => {
            res.status(500).json({ error: err.message });
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const deleteModel = async (req: Request, res: Response) => {
  const currentUser = (req as any).user;
  if (currentUser.role !== 'admin') {
    return res.status(403).json({message: 'Only admins can delete ollama models'});
  }

  try {
    const {id, name} = req.params;
    const node = await getNodeById(Number(id));

    const status = await checkOnline(node.ip, node.port);
    if (status === 'offline') {
      return res.status(500).json({error: "Node is offline"});
    }

    const resp = await fetch(`${buildOllamaUrl(node)}/api/delete`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({name})
    });

    if (resp.status === 200) {
      console.log(`✅ Deleted Ollama model '${name}' on node '${node.hostname}' [Status: ${resp.status}]`);
      return res.json({
        node: node.hostname,
        message: `Model ${name} deleted or was already removed`,
        status: resp.status
      });
    }

    return res.status(resp.status).json({
      error: `Failed to delete model with status ${resp.status}`
    });
  } catch (err: any) {
    res.status(500).json({error: err.message});
  }
};

export const stopModel = async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    if (currentUser.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can stop ollama models' });
    }

    try {
        const { id } = req.params;
        const node = await getNodeById(Number(id));

        const status = await checkOnline(node.ip, node.port);
        if (status === 'offline') {
            return res.status(500).json({ error: "Node is offline" });
        }

        const resp = await fetch(`${buildOllamaUrl(node)}/api/stop`, { method: "POST" });
        res.json({ node: node.hostname, status: resp.status });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};
