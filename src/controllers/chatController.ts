import { Request, Response } from "express";
import { pool } from "../core/database";
import * as JobManager from "../core/jobManager";
import { type OllamaMessage } from "../core/aiHelpers";
import { ComputeNode } from "../types/computeNode";
import { ChatMode, ToolName } from "../types/constants";
import { resolveNode } from "../middleware/resolveNode";
import {
  resolveChatSession,
  generateChatTitle,
  fetchChatHistory,
  saveMessage,
} from "../services/chatService";
import { streamAIMessage } from "../services/agentService";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — Logging
// ─────────────────────────────────────────────────────────────────────────────

const log   = (scope: string, msg: string, data?: unknown) =>
  data !== undefined ? console.log(`  [${scope}] ${msg}`, data) : console.log(`  [${scope}] ${msg}`);

const warn  = (scope: string, msg: string, data?: unknown) =>
  data !== undefined ? console.warn(`  [${scope}] ⚠ ${msg}`, data) : console.warn(`  [${scope}] ⚠ ${msg}`);

const error = (scope: string, msg: string, err?: unknown) =>
  err !== undefined ? console.error(`  [${scope}] ✖ ${msg}`, err) : console.error(`  [${scope}] ✖ ${msg}`);

const createLogger = (chatId: number | string) => ({
  log:   (scope: string, msg: string, data?: unknown) => log(`${scope} #${chatId}`, msg, data),
  warn:  (scope: string, msg: string, data?: unknown) => warn(`${scope} #${chatId}`, msg, data),
  error: (scope: string, msg: string, err?: unknown)  => error(`${scope} #${chatId}`, msg, err),
});

// ─────────────────────────────────────────────────────────────────────────────
// MODES — System message per mode
// ─────────────────────────────────────────────────────────────────────────────

const getSystemMessage = (
  mode: ChatMode,
  rag: { limit: number; use_advanced: boolean; use_web_search: boolean }
): OllamaMessage => {
  const toolHints =
    `You have access to tools: use ${ToolName.GET_CURRENT_DATE} for date/time use this tool user asks for actual data so you know what is the current date and time, ` +
    (rag.limit > 0 ? `${ToolName.GET_KNOWLEDGE} to search internal documents use this tool as first source of information, ` : "") +
    (rag.use_web_search ? `${ToolName.WEB_SEARCH} to find current information on the web, ` : "") +
    (rag.use_web_search ? `${ToolName.WEB_FETCH} to retrieve a specific web page. ` : "") +
    "Use tools whenever they would help answer the user's question more accurately.";

  const base = "Your name is CerberusAI. Use user's language as output. When used something from RAG mention the source. ";

  const prompts: Record<ChatMode, string> = {
    [ChatMode.CHAT]:
      base +
      "You are a smart cybersecurity assistant. Help users with any cybersecurity topic — " +
      "vulnerabilities, defenses, tools, concepts, and best practices. " +
      toolHints,

    [ChatMode.MALWARE]:
      base +
      "You are a malware analysis advisor. Your goal is to help users detect, identify, and understand malware. " +
      "Ask clarifying questions to gather more context (symptoms, behavior, file names, hashes, network activity, etc.) " +
      "before drawing conclusions. Guide the user step by step through the analysis process. " +
      "Never provide working malware code — focus purely on detection, recognition, and remediation. " +
      toolHints,

    [ChatMode.PENTEST]:
      base +
      "You are a penetration testing advisor. Help users plan and execute ethical penetration tests. " +
      "Cover reconnaissance, scanning, exploitation, post-exploitation, and reporting phases. " +
      "Always assume the user has proper authorization for the target. " +
      "Recommend tools (nmap, Burp Suite, Metasploit, etc.) and explain techniques clearly. " +
      toolHints,
  };

  return { role: "system", content: prompts[mode] ?? prompts[ChatMode.CHAT] };
};

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLERS — Public route handlers
// ─────────────────────────────────────────────────────────────────────────────

export const createChat = async (req: Request, res: Response) => {
  try {
    const { title } = req.body;
    const user = req.user;

    const { rows } = await pool.query(
      `INSERT INTO chats (title, created_by) VALUES ($1, $2) RETURNING *`,
      [title, user.id]
    );
    const chat = rows[0];

    await pool.query(
      `INSERT INTO chat_users (chat_id, user_id) VALUES ($1, $2)`,
      [chat.id, user.id]
    );

    log("Chat", `Created chat #${chat.id} — "${title}" by user #${user.id}`);
    res.json(chat);
  } catch (err: any) {
    error("Chat", "Failed to create chat", err);
    res.status(500).json({ error: err.message });
  }
};

export const getUserChats = async (req: Request, res: Response) => {
  try {
    const user = req.user;

    const { rows } = await pool.query(
      `SELECT c.* FROM chats c
                           JOIN chat_users cu ON c.id = cu.chat_id
       WHERE cu.user_id = $1
       ORDER BY c.last_modified DESC`,
      [user.id]
    );

    log("Chat", `Fetched ${rows.length} chats for user #${user.id}`);
    res.json(rows);
  } catch (err: any) {
    error("Chat", "Failed to fetch user chats", err);
    res.status(500).json({ error: err.message });
  }
};

export const getChatMessages = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const { rows: access } = await pool.query(
      `SELECT * FROM chat_users WHERE chat_id = $1 AND user_id = $2`,
      [Number(id), user.id]
    );

    if (access.length === 0 && user.role !== "admin") {
      return res.status(403).json({ message: "You are not authorized to view this chat" });
    }

    const { rows: messages } = await pool.query(
      `SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC`,
      [id]
    );

    log("Chat", `Fetched ${messages.length} messages for chat #${id} (user #${user.id})`);
    res.json(messages);
  } catch (err: any) {
    error("Chat", "Failed to fetch chat messages", err);
    res.status(500).json({ error: err.message });
  }
};

const runGenerationJob = async (
  jobId: string,
  chatId: number,
  chatObject: any,
  isNewChat: boolean,
  node: ComputeNode,
  model: string,
  mode: ChatMode,
  rag: { limit: number; use_advanced: boolean; use_web_search: boolean },
  content: string,
  userId: number,
): Promise<void> => {
  const clog = createLogger(chatId);
  const emit = (payload: Record<string, unknown>) => JobManager.appendChunk(jobId, payload);

  emit({ generation_state: "thinking" });
  let titleJob: Promise<string> | null = null;

  if (isNewChat) {
    titleJob = generateChatTitle(node.id, model, content).catch((err: any) => {
      clog.log("Chat", `Title generation failed: ${err.message}`);
      return "";
    });
  }

  const systemMessage: OllamaMessage = getSystemMessage(mode, rag);
  const history = await fetchChatHistory(chatId);

  emit({ generation_state: "generating" });
  const generatedContent = await streamAIMessage(
    content, systemMessage, history, rag, node, model, emit, clog
  );

  const aiMessage = await saveMessage(chatId, "ai", null, generatedContent);
  emit({ generated_message: aiMessage });

  if (titleJob) {
    const title = await titleJob;
    if (title) {
      await pool.query(`UPDATE chats SET title = $1 WHERE id = $2`, [title, chatId]);
      chatObject.title = title;
      emit({ chat: chatObject });
    }
  }

  clog.log("Chat", `Generation job ${jobId} complete`);
  JobManager.completeJob(jobId);
};

export const postChatMessage = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { node_id, model, mode, rag, content } = req.body as {
    node_id: number;
    model: string;
    mode: ChatMode;
    rag: { limit: number; use_advanced: boolean; use_web_search: boolean };
    content: string;
  };
  const user = req.user;

  try {
    log("Chat", `Incoming message — chat: ${id}, model: ${model}, user: #${user.id}`);

    const { node } = await resolveNode(Number(node_id));
    log("Node", `Node #${node_id} is online`);

    const { chatId, isNewChat, chatObject } = await resolveChatSession(id, user.id);

    const userMessage = await saveMessage(chatId, "user", user.id, content);

    const job = JobManager.createJob(chatId, user.id);

    res.json({
      jobId: job.id,
      chat: chatObject,
      userMessage: userMessage,
    });

    runGenerationJob(job.id, chatId, chatObject, isNewChat, node, model, mode, rag, content, user.id)
      .catch((err: any) => {
        error("Chat", `Generation job ${job.id} failed`, { message: err.message, stack: err.stack });
        JobManager.failJob(job.id, err.message);
      });
  } catch (err: any) {
    error("Chat", `postChatMessage failed — chat ${id}`, { message: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
};

export const deleteChat = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const { rows } = await pool.query(`SELECT * FROM chats WHERE id = $1`, [id]);
    const chat = rows[0];

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    const isOwner = chat.created_by === user.id;
    const isAdmin = user.role === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "You are not authorized to delete this chat" });
    }

    await pool.query(`DELETE FROM chats WHERE id = $1`, [id]);

    log("Chat", `Chat #${id} deleted by user #${user.id} (${isAdmin ? "admin" : "owner"})`);
    res.json({ message: "Chat deleted successfully" });
  } catch (err: any) {
    error("Chat", "Failed to delete chat", err);
    res.status(500).json({ error: err.message });
  }
};
