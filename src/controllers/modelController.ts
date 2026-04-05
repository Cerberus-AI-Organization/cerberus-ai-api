import { Request, Response } from 'express';
import {checkNodeOnline, getNodeById} from './computeNodeController';
import { createNodeProvider } from '../core/providers';
import { runAISync } from '../core/AIHelpers';

export const listModels = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const node = await getNodeById(Number(id));

    const status = await checkNodeOnline(node);
    if (status === 'offline') {
      return res.status(500).json({ error: 'Node is offline' });
    }

    const provider = createNodeProvider(node);
    const models = await provider.listModels();

    res.json(models.filter(m => !m.name.toLowerCase().includes('embed')));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const pullModel = async (req: Request, res: Response) => {
  const currentUser = (req as any).user;

  if (currentUser.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can pull ollama models' });
  }

  console.log(`User [${currentUser.id}](${currentUser.role}) pulling model [${req.body.name}] on node [${req.params.id}]`);

  try {
    const { id } = req.params;
    const { name } = req.body;
    const node = await getNodeById(Number(id));

    const status = await checkNodeOnline(node);
    if (status === 'offline') {
      return res.status(500).json({ error: 'Node is offline' });
    }

    const provider = createNodeProvider(node);
    if (!provider.canManageModels()) {
      return res.status(501).json({ error: 'Model management is not supported for this node type' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();

    const stream = await provider.pullModel(name);
    for await (const chunk of stream) {
      res.write(JSON.stringify(chunk) + '\n');
    }
    res.end();
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
};

export const deleteModel = async (req: Request, res: Response) => {
  const currentUser = (req as any).user;

  if (currentUser.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can delete ollama models' });
  }

  console.log(`User [${currentUser.id}](${currentUser.role}) deleting model [${req.params.name}] on node [${req.params.id}]`);

  try {
    const { id, name } = req.params;
    const node = await getNodeById(Number(id));

    const status = await checkNodeOnline(node);
    if (status === 'offline') {
      return res.status(500).json({ error: 'Node is offline' });
    }

    const provider = createNodeProvider(node);
    if (!provider.canManageModels()) {
      return res.status(501).json({ error: 'Model management is not supported for this node type' });
    }

    await provider.deleteModel(name);
    console.log(`✅ Deleted model '${name}' on node '${node.hostname}'`);

    res.json({ node: node.hostname, message: `Model ${name} deleted or was already removed` });
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

    const status = await checkNodeOnline(node);
    if (status === 'offline') {
      return res.status(500).json({ error: 'Node is offline' });
    }

    const provider = createNodeProvider(node);
    if (!provider.canManageModels()) {
      return res.status(501).json({ error: 'Stop model is not supported for this node type' });
    }

    await provider.stopModels();
    res.json({ node: node.hostname, status: 200 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const preloadModel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { model } = req.body;
    const node = await getNodeById(Number(id));

    const status = await checkNodeOnline(node);
    if (status === 'offline') {
      return res.status(500).json({ error: 'Node is offline' });
    }

    const provider = createNodeProvider(node);
    if (!provider.canManageModels()) {
      return res.status(501).json({ error: 'Preload is not supported for this node type' });
    }

    const models = await provider.listModels();
    const runningModels = models.map(m => m.name);

    if (runningModels.includes(model)) {
      console.log(`Model ${model} is already running on node ${node.hostname}`);
      return res.json({ node: node.hostname, model, status: 'already_running' });
    }

    if (model.toLowerCase().includes('embed')) {
      return res.json({ node: node.hostname, model, status: 'cannot_preload' });
    }

    if (model.toLowerCase().includes('cloud')) {
      return res.json({ node: node.hostname, model, status: 'cloud_model' });
    }

    console.log(`Preloading model ${model} on node ${node.hostname}`);
    const result = await runAISync(node.id, model, [
      { role: 'user', content: 'hi' },
    ], {
      think: false,
      num_ctx: 512,
      num_predict: 1,
    });

    console.log(`Model ${model} preloaded on node ${node.hostname} - ${result.content}`);
    res.json({ node: node.hostname, model, status: 'preloaded' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
