import { pool } from '../core/database';
import { type OllamaMessage, runAISync } from '../core/aiHelpers';
import { Message } from '../types/message';

// ─────────────────────────────────────────────────────────────────────────────
// Text processing helpers
// ─────────────────────────────────────────────────────────────────────────────

export const stripThinkTags = (content: string): string => {
  if (content.includes('</think>')) {
    return content.split('</think>').pop()!.trim();
  }
  return content;
};

export const extractTitle = (content: string): string => {
  const match = content.match(/<title>([\s\S]*?)<\/title>/i);
  const raw = match?.[1] ?? content;
  return raw
    .trim()
    .replace(/["'*]/g, '')
    .replace(/<\/?title>/gi, '')
    .replace(/[<>]/g, '');
};

// ─────────────────────────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────────────────────────

export const resolveChatSession = async (
  id: string,
  userId: number
): Promise<{ chatId: number; isNewChat: boolean; chatObject: Record<string, unknown> }> => {
  const chatId = Number(id);

  if (chatId !== -1) {
    const { rows } = await pool.query(
      `SELECT 1 FROM chat_users WHERE chat_id = $1 AND user_id = $2`,
      [chatId, userId]
    );
    if (rows.length === 0) {
      throw new Error('You are not authorized to send messages in this chat');
    }
    return { chatId, isNewChat: false, chatObject: rows[0] };
  }

  const chatResult = await pool.query(
    `INSERT INTO chats (title, created_by) VALUES ($1, $2) RETURNING *`,
    ['New Chat', userId]
  );
  const chat = chatResult.rows[0];
  await pool.query(
    `INSERT INTO chat_users (chat_id, user_id) VALUES ($1, $2)`,
    [chat.id, userId]
  );

  return { chatId: chat.id, isNewChat: true, chatObject: chat };
};

// ─────────────────────────────────────────────────────────────────────────────
// Title generation
// ─────────────────────────────────────────────────────────────────────────────

export const generateChatTitle = async (
  nodeId: number,
  model: string,
  content: string
): Promise<string> => {
  const prompt: OllamaMessage[] = [
    { role: 'system', content: 'Create short title (max 5 words). Return <title>.</title>' },
    { role: 'user', content: `Create title for: [${content.slice(0, 300)}]` },
  ];

  const response = await runAISync(nodeId, model, prompt, {
    think: false,
    num_ctx: 512,
    temperature: 0.8,
  });
  return extractTitle(stripThinkTags(response.content.trim()));
};

// ─────────────────────────────────────────────────────────────────────────────
// Message storage & history
// ─────────────────────────────────────────────────────────────────────────────

export const fetchChatHistory = async (chatId: number): Promise<OllamaMessage[]> => {
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE chat_id = $1 ORDER BY id ASC`,
    [chatId]
  );
  return rows.map((m) => ({
    role: m.sender_type === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));
};

export const saveMessage = async (
  chatId: number,
  userType: 'user' | 'ai',
  userId: number | null,
  content: string
): Promise<Message> => {
  const { rows } = await pool.query(
    `INSERT INTO messages (chat_id, sender_type, sender_id, content)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [chatId, userType, userId, content]
  );
  return rows[0];
};
