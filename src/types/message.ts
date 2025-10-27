import {Chat} from "./chat";

export interface Message {
    id: number;
    chat: Chat;
    sender_type: 'user' | 'ai';
    sender_id?: number;
    content: string;
    created_at: Date;
}