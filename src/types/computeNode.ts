
export interface ComputeNode {
    id: number;
    hostname: string;
    ip: string;
    port: number;
    priority: number;
    max_ctx: number;
    max_layers_on_gpu: number;
    added_by: number | null;
    status: 'online' | 'offline';
    created_at: Date;
}