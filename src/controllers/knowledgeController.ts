import { Request, Response } from "express";
import { Knowledge } from "../core/rag/Knowledge";
import { getNodeById } from "./computeNodeController";

export const getKnowledge = async (req: Request, res: Response) => {
  try {
    const knowledge = Knowledge.instance;
    const sources = await knowledge.getAllIndexedSources()

    res.json(sources);
  } catch (err) {
    res.status(500).json({message: `Failed to get knowledge sources ${err}`});
  }
}

export const searchKnowledge = async (req: Request, res: Response) => {
  try {
    const {query, limit, node_id} = req.body;
    const node = await getNodeById(Number(node_id));

    const knowledge = Knowledge.instance;
    const sources = await knowledge.search(query, node, limit)

    res.json(sources);
  } catch (err) {
    res.status(500).json({message: `Failed to search knowledge ${err}`}
    )
  }
}