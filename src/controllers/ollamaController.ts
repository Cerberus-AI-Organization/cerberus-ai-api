import { Request, Response } from 'express';
import fetch from 'node-fetch';
import { pool } from '../core/database';
import {checkOnline} from "./computeNodeController";
import {createOllamaClientFromNode, buildOllamaUrl, runOllamaSync} from "../core/ollama";
import {ComputeNode} from "../types/computeNode";

export async function getNodeById(id: number): Promise<ComputeNode> {
    const result = await pool.query('SELECT * FROM compute_nodes WHERE id = $1', [id]);
    if (result.rows.length === 0) {
        throw new Error('Compute node not found');
    }
    return result.rows[0];
}

export const listModels = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const node = await getNodeById(Number(id));

    const status = await checkOnline(node.ip, node.port);
    if (status === "offline") {
      return res.status(500).json({ error: "Node is offline" });
    }

    const ollama = createOllamaClientFromNode(node);
    const data = await ollama.list();

    res.json(
      data.models.map(model => ({
        name: model.name,
        size: model.size,
      })).filter(model =>
        !model.name.toLowerCase().includes("embed"
      ))
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const pullModel = async (req: Request, res: Response) => {
  const currentUser = (req as any).user;

  console.log(`User [${currentUser.id}](${currentUser.role}) pulling model [${req.body.name} on node [${req.params.id}]`);

  if (currentUser.role !== "admin") {
    return res.status(403).json({
      message: "Only admins can pull ollama models",
    });
  }

  let stream: AsyncIterable<any> | null = null;

  try {
    const {id} = req.params;
    const {name} = req.body;
    const node = await getNodeById(Number(id));

    const status = await checkOnline(node.ip, node.port);
    if (status === "offline") {
      return res.status(500).json({error: "Node is offline"});
    }

    const ollama = createOllamaClientFromNode(node);

    const setupStreamingHeaders = (res: Response) => {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Transfer-Encoding", "chunked");
      res.flushHeaders();
    };
    setupStreamingHeaders(res);

    stream = await ollama.pull({
      model: name,
      stream: true,
    });

    for await (const chunk of stream) {
      res.write(JSON.stringify(chunk) + "\n");
    }

    res.end();
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({error: err.message});
    }
  } finally {
    if (stream) {
      try {
        await (stream as any).return?.();
      } catch (e) {
        console.error("Error during stream cleanup", e);
      }
    }
  }
};

export const deleteModel = async (req: Request, res: Response) => {
  const currentUser = (req as any).user;

  if (currentUser.role !== "admin") {
    return res.status(403).json({
      message: "Only admins can delete ollama models",
    });
  }

  console.log(`User [${currentUser.id}](${currentUser.role}) deleting model [${req.params.name} on node [${req.params.id}]`);

  try {
    const { id, name } = req.params;
    const node = await getNodeById(Number(id));

    const status = await checkOnline(node.ip, node.port);
    if (status === "offline") {
      return res.status(500).json({ error: "Node is offline" });
    }

    const ollama = createOllamaClientFromNode(node);
    await ollama.delete({ model: name });

    console.log(
      `✅ Deleted Ollama model '${name}' on node '${node.hostname}'`
    );

    res.json({
      node: node.hostname,
      message: `Model ${name} deleted or was already removed`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

        const resp = await fetch(`${buildOllamaUrl(node.ip, node.port)}/api/stop`, { method: "POST" });
        res.json({ node: node.hostname, status: resp.status });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const preloadModel = async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    const {model} = req.body;
    const node = await getNodeById(Number(id));

    const status = await checkOnline(node.ip, node.port);
    if (status === "offline") {
      return res.status(500).json({error: "Node is offline"});
    }

    const ollama = createOllamaClientFromNode(node);
    const runningModels = (await ollama.ps()).models.map(model => model.name);

    if (runningModels.includes(model)) {
      console.log(`Model ${model} is already running on node ${node.hostname}`);
      return res.json({
        node: node.hostname,
        model: model,
        status: "already_running",
      })
    }

    if (model.toLowerCase().includes("embed")) {
      console.log(`Model ${model} is an embedding model and cannot be preloaded`);
      return res.json({
        node: node.hostname,
        model: model,
        status: "cannot_preload",
      })
    }

    if (model.toLowerCase().includes("cloud")) {
      console.log(`Model ${model} is a cloud model and cannot be preloaded`);
      return res.json({
        node: node.hostname,
        model: model,
        status: "cloud_model",
      })
    }

    console.log(`Preloading model ${model} on node ${node.hostname}`);
    const result = await runOllamaSync(node.id, model, [
      {role: "user", content: "hi"},
    ], {
      think: false,
      num_ctx: 512,
      num_predict: 1,
    });

    console.log(`Model ${model} preloaded on node ${node.hostname} - ${result.content}`);

    res.json({
      node: node.hostname,
      model: model,
      status: "preloaded",
    });
  } catch (err: any) {
    res.status(500).json({error: err.message});
  }
};
