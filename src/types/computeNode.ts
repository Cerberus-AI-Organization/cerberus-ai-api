
export interface ComputeNode {
    id: number;
    hostname: string;
    url: string;
    priority: number;
    max_ctx: number;
    max_layers_on_gpu: number;
    added_by: number | null;
    status: 'online' | 'offline';
    api_type: 'ollama' | 'openai';
    api_key: string | null;
    created_at: Date;
}
