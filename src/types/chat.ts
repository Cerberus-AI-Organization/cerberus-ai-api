import {User} from "./user";
import {Message} from "./message";

export interface Chat {
    id: number;
    title: string;
    messages: Message[];
    users: User[];
    created_at: Date;
    created_by: User;
    last_modified: Date;
}