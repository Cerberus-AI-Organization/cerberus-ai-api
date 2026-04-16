import { Tool, WebFetchResponse, WebSearchResult } from 'ollama';
import { ComputeNode } from '../types/computeNode';
import { createNodeProvider } from '../core/providers';
import { ToolName } from '../types/constants';

export const getTools = (includeTools: ToolName[]): Tool[] => {
  const tools: Tool[] = [
    {
      type: 'function',
      function: {
        name: ToolName.GET_CURRENT_DATE,
        description: 'Retrieve the current date and time',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: ToolName.GET_KNOWLEDGE,
        description: 'Search internal knowledge base / documents for relevant information',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: ToolName.WEB_SEARCH,
        description: 'Search the web for current information using a text query. Returns title, url, short content.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: ToolName.WEB_FETCH,
        description: 'Retrieve the full content of a specific web page by URL',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL of the web page' },
          },
          required: ['url'],
        },
      },
    },
  ];

  return tools.filter(
    (tool) => tool.function?.name && includeTools.includes(tool.function.name as ToolName)
  );
};

export const getCurrentDate = (): string => new Date().toISOString();

export const webSearch = async (
  query: string,
  limit: number,
  node: ComputeNode
): Promise<WebSearchResult[]> => {
  const provider = createNodeProvider(node);
  return provider.webSearch(query, limit);
};

export const webFetch = async (url: string, node: ComputeNode): Promise<WebFetchResponse> => {
  const provider = createNodeProvider(node);
  return provider.webFetch(url);
};
