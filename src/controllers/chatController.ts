import {Request, Response} from "express";
import {pool} from "../core/database";
import {checkOnline} from "./computeNodeController";
import {getNodeById} from "./ollamaController";
import {OllamaMessage, runOllamaStream, runOllamaSync} from "../core/ollama";
import {Message} from "../types/message";

export const createChat = async (req: Request, res: Response) => {
  try {
    const {title} = req.body;
    const user = (req as any).user;

    const chatResult = await pool.query(
      `INSERT INTO chats (title, created_by)
       VALUES ($1, $2)
       RETURNING *`,
      [title, user.id]
    );

    const chat = chatResult.rows[0];

    await pool.query(
      `INSERT INTO chat_users (chat_id, user_id)
       VALUES ($1, $2)`,
      [chat.id, user.id]
    );

    res.json(chat);
  } catch (err: any) {
    res.status(500).json({error: err.message});
  }
};

export const getUserChats = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const result = await pool.query(
      `SELECT c.*
       FROM chats c
                JOIN chat_users cu ON c.id = cu.chat_id
       WHERE cu.user_id = $1
       ORDER BY c.last_modified DESC`,
      [user.id]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({error: err.message});
  }
};

export const getChatMessages = async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    const user = (req as any).user;

    const resultChatUsers = await pool.query(`SELECT *
                                              FROM chat_users
                                              WHERE chat_id = $1
                                                AND user_id = $2`,
      [Number(id), user.id]);
    if (resultChatUsers.rows.length === 0 || (resultChatUsers.rows.length === 0 && user.role !== 'admin')) {
      return res.status(403).json({message: 'You are not authorized to send messages in this chat'});
    }

    const result = await pool.query(
      `SELECT *
       FROM messages
       WHERE chat_id = $1
       ORDER BY created_at ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({error: err.message});
  }
};

export const postChatMessage = async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    const {node_id, model, content} = req.body;
    const user = (req as any).user;

    const node = await getNodeById(Number(node_id));
    const status = await checkOnline(node.ip, node.port);
    if (status === 'offline') {
      return res.status(500).json({error: "Node is offline"});
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders();

    let chatId = Number(id);
    if (chatId != -1) {
      const result = await pool.query(`SELECT *
                                       FROM chat_users
                                       WHERE chat_id = $1
                                         AND user_id = $2`,
        [id, user.id]);

      if (result.rows.length === 0) {
        res.write(JSON.stringify({error: "You are not authorized to send messages in this chat"}) + "\n");
        res.end()
        return;
      }
    } else {
      const chatTitleGenerated = await runOllamaSync(Number(node_id), model, [
        {role: "system", content: "Your name is CerberusAI and you must help people in cybersecurity."},
        {role: "system", content: `Create a new chat title (max 5 words) from content and return it as a string. Return it in language of the user. Return only text not \"`},
        {role: "user", content: `Create chat title for this message in chat: [${content}], return only title with no \" or else`},
      ]);

      const cleanedTitle = chatTitleGenerated.content.trim().replace(/["']/g, "");

      const chatResult = await pool.query(
        `INSERT INTO chats (title, created_by)
         VALUES ($1, $2)
         RETURNING *`,
        [cleanedTitle, user.id]
      );
      const chat = chatResult.rows[0];
      chatId = chat.id;

      await pool.query(
        `INSERT INTO chat_users (chat_id, user_id)
         VALUES ($1, $2)`,
        [chat!.id, user.id]
      );
      res.write(JSON.stringify({chat: chat}) + "\n");
    }

    const chatMessagesResult = await pool.query(`SELECT * FROM messages WHERE chat_id = $1 ORDER BY messages.id`, [chatId]);
    const chatMessages: OllamaMessage[] = chatMessagesResult.rows.map(m => ({
      role: m.sender_type === 'user' ? 'user' : 'assistant',
      content: m.content
    }));

    const messageResult = await pool.query(
      `INSERT INTO messages (chat_id, sender_type, sender_id, content)
       VALUES ($1, 'user', $2, $3)
       RETURNING *`,
      [chatId, user.id, content]
    );
    const message: Message = messageResult.rows[0];
    res.write(JSON.stringify({message: message}) + "\n");

    let generatedMessageContent = "";
    for await (const chunk of runOllamaStream(Number(node_id), model, [
      {role: "system", content: "Your name is CerberusAI and you must help people in cybersecurity."},
      ...chatMessages,
      {role: "user", content: content}
    ])) {
      generatedMessageContent += chunk.content;
      if (chunk.content !== "")
        res.write(JSON.stringify({generated_chunk: chunk}) + "\n");
    }

    if (generatedMessageContent.trim() === "") {
      generatedMessageContent = "Failed to generate message content. Please try again later.";
    }

    const generatedResult = await pool.query(
      `INSERT INTO messages (chat_id, sender_type, sender_id, content)
       VALUES ($1, 'ai', $2, $3)
       RETURNING *`,
      [chatId, null, generatedMessageContent]
    );
    const generatedMessage: Message = generatedResult.rows[0];
    res.write(JSON.stringify({generated_message: generatedMessage}) + "\n");

    res.end();
  } catch (err: any) {
    res.write(JSON.stringify({error: err.message}) + "\n");
    res.end();
  }
}

export const deleteChat = async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    const user = (req as any).user;

    const result = await pool.query(
      `SELECT *
       FROM chats
       WHERE id = $1`,
      [id]
    );
    const chat = result.rows[0];

    if (!chat) {
      return res.status(404).json({message: 'Chat not found'});
    }

    if (chat.created_by !== user.id || chat.created_by !== user.id && user.role !== 'admin') {
      return res.status(403).json({message: 'You are not authorized to delete this chat'});
    }

    const resultDelete = await pool.query(
      `DELETE
       FROM chats
       WHERE id = $1`,
      [id]
    );

    res.json({message: 'Chat deleted successfully'});
  } catch (err: any) {
    res.status(500).json({error: err.message});
  }
}