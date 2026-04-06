import { Request, Response } from 'express';
import { Knowledge } from '../core/rag/knowledge';

export const getApiInfo = async (req: Request, res: Response) => {
    const knowledge = Knowledge.instance;
    const knowledgeStatus = knowledge.syncing
        ? 'syncing'
        : (await knowledge.isEmpty() ? 'empty' : 'ready');

    res.json({
        name: 'Cerberus AI API',
        description: 'API for Cerberus AI',
        status: 'online',
        components: {
            brave_websearch: process.env.BRAVE_SEARCH_API_KEY ? 'configured' : 'not configured',
            knowledge: knowledgeStatus,
        },
    });
};
