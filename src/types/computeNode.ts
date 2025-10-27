
export interface ComputeNode {
    id: number;
    hostname: string;
    ip: string;
    port: number;
    added_by: number | null;
    status: 'online' | 'offline';
    created_at: Date;
}