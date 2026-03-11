import {Request, Response} from "express";
import {pool} from "../core/database";
import {checkOnline} from "./computeNodeController";
import {getNodeById} from "./ollamaController";
import {countTokens, type OllamaMessage, runOllamaStream, runOllamaSync} from "../core/ollama";
import {Message} from "../types/message";
import {Knowledge} from "../core/rag/knowledge";
import {ComputeNode} from "../types/computeNode";
import {DocumentRow} from "../core/rag/types";
import {encoding_for_model} from "tiktoken";
import {Tool, ToolCall} from "ollama";

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
// HELPERS — Streaming
// ─────────────────────────────────────────────────────────────────────────────

const setupStreamingHeaders = (res: Response) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders();
};

const streamWrite = (res: Response, payload: Record<string, unknown>) => {
  res.write(JSON.stringify(payload) + "\n");
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — Text processing
// ─────────────────────────────────────────────────────────────────────────────

const stripThinkTags = (content: string): string => {
  if (content.includes("</think>")) {
    return content.split("</think>").pop()!.trim();
  }
  return content;
};

const extractTitle = (content: string): string => {
  const match = content.match(/<title>([\s\S]*?)<\/title>/i);
  const raw = match?.[1] ?? content;
  return raw
    .trim()
    .replace(/["'*]/g, "")
    .replace(/<\/?title>/gi, "")
    .replace(/[<>]/g, "");
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — Node validation
// ─────────────────────────────────────────────────────────────────────────────

const validateNodeStatus = async (nodeId: number): Promise<ComputeNode> => {
  const node = await getNodeById(nodeId);
  const status = await checkOnline(node.ip, node.port);
  if (status === "offline") {
    throw new Error(`Node #${nodeId} (${node.ip}:${node.port}) is offline`);
  }
  log("Node", `Node #${nodeId} is online`);
  return node;
};

// ─────────────────────────────────────────────────────────────────────────────
// CHAT — Session management
// ─────────────────────────────────────────────────────────────────────────────

const resolveChatSession = async (
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
      throw new Error("You are not authorized to send messages in this chat");
    }
    log("Chat", `Resolved existing chat #${chatId} for user #${userId}`);
    return { chatId, isNewChat: false, chatObject: rows[0] };
  }

  const chatResult = await pool.query(
    `INSERT INTO chats (title, created_by) VALUES ($1, $2) RETURNING *`,
    ["New Chat", userId]
  );
  const chat = chatResult.rows[0];
  await pool.query(
    `INSERT INTO chat_users (chat_id, user_id) VALUES ($1, $2)`,
    [chat.id, userId]
  );

  log("Chat", `Created new chat #${chat.id} for user #${userId}`);
  return { chatId: chat.id, isNewChat: true, chatObject: chat };
};

const generateChatTitle = async (
  nodeId: number,
  model: string,
  content: string
): Promise<string> => {
  const prompt: OllamaMessage[] = [
    { role: "system", content: "Create short title (max 5 words). Return <title>.</title>" },
    { role: "user", content: `Create title for: [${content.slice(0, 300)}]` },
  ];

  const response = await runOllamaSync(nodeId, model, prompt, {
    think: false,
    num_ctx: 512,
    temperature: 0.8,
  });
  const title = extractTitle(stripThinkTags(response.content.trim()));

  log("Chat", `Generated title: "${title}"`);
  return title;
};

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES — Storage & history
// ─────────────────────────────────────────────────────────────────────────────

const fetchChatHistory = async (chatId: number): Promise<OllamaMessage[]> => {
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE chat_id = $1 ORDER BY id ASC`,
    [chatId]
  );
  return rows.map((m) => ({
    role: m.sender_type === "user" ? "user" : "assistant",
    content: m.content,
  }));
};

const saveMessage = async (
  chatId: number,
  userType: "user" | "ai",
  userId: number | null,
  content: string
): Promise<Message> => {
  const { rows } = await pool.query(
    `INSERT INTO messages (chat_id, sender_type, sender_id, content)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [chatId, userType, userId, content]
  );
  log("Message", `Saved [${userType}] message #${rows[0].id} in chat #${chatId}`);
  return rows[0];
};

// ─────────────────────────────────────────────────────────────────────────────
// RAG — Retrieval augmented generation
// ─────────────────────────────────────────────────────────────────────────────

const extractSearchQueries = (content: string): string[] => {
  const matches = [...content.matchAll(/<query>([\s\S]*?)<\/query>/gi)];
  return matches.length > 0
    ? matches.map((m) => m[1].trim()).filter(Boolean)
    : [content.trim()];
};

const generateRagQueries = async (
  chatMessages: OllamaMessage[],
  node: ComputeNode,
  model: string,
  clog: ReturnType<typeof createLogger>
): Promise<string[]> => {
  const context = chatMessages
    .slice(-3)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const messages: OllamaMessage[] = [
    {
      role: "system",
      content: `You generate semantic search queries for a vector database.

Rules:
- Focus mainly on the LAST user message.
- Use previous messages only if necessary.
- Queries should be natural language search phrases.
- Include important technologies, entities, and concepts.
- Avoid conversational filler.
- Prefer semantic clarity over short keywords.

Decide query count:
- Simple question → 1 query
- Complex question → up to 3 queries

Return strictly in XML:
<queries>
  <query>text</query>
</queries>

Do not output anything outside the XML.`,
    },
    { role: "user", content: `Messages for summary: ${context}` },
  ];

  const num_ctx = countTokens(messages.map((m) => m.content).join("\n")) + 512;
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await runOllamaSync(node.id, model, messages, {
      think: "medium",
      num_ctx: num_ctx,
    }).catch((err) => {
      clog.error("RAG", `Query generation attempt ${attempt} failed`, err);
      return { content: "", done: true };
    });

    const queries = extractSearchQueries(stripThinkTags(response.content.trim()));
    if (queries.length > 0 && queries.every((q) => q.length > 0)) {
      clog.log("RAG", `Generated ${queries.length} search quer${queries.length > 1 ? "ies" : "y"}`, queries);
      return queries;
    }

    clog.warn("RAG", `Attempt ${attempt}/${MAX_RETRIES} produced invalid queries, retrying...`);
  }

  throw new Error("Failed to generate RAG queries after multiple attempts");
};

const filterRagResults = (results: DocumentRow[]): DocumentRow[] => {
  return results
    .map((doc) => ({
      ...doc,
      chunks: doc.chunks.filter((chunk) => chunk.score >= 0.5),
    }))
    .filter((doc) => doc.chunks.length > 0);
};

const formatRagResults = (results: DocumentRow[]): string => {
  return results
    .flatMap((doc) =>
      doc.chunks.map((chunk) => {
        const structure = chunk.text
          .substring(chunk.text.indexOf("STRUCTURE: ") + "STRUCTURE: ".length, chunk.text.indexOf("TEXT: "))
          .trim();
        const text = chunk.text
          .substring(chunk.text.indexOf("TEXT: ") + "TEXT: ".length)
          .trim();
        return `---\nSOURCE: ${doc.source} (PAGE: ${chunk.page_source})\nSTRUCTURE: ${structure}\nTEXT: ${text}\n---`;
      })
    )
    .join("\n\n");
};

const getRag = async (
  chatMessages: OllamaMessage[],
  limit: number,
  use_advanced_rag: boolean,
  node: ComputeNode,
  model: string,
  clog: ReturnType<typeof createLogger>
): Promise<{ rag_results: DocumentRow[]; rag_formated: string }> => {
  const queries = await generateRagQueries(chatMessages, node, model, clog);
  const knowledge = Knowledge.instance;

  const rawResults = await Promise.all(
    queries.map((q) =>
      use_advanced_rag
        ? knowledge.searchWithRerank(q, node, model, limit * 2, limit)
        : knowledge.search(q, node, limit)
    )
  );

  const deduped = knowledge.deduplicateDocumentRows(rawResults.flat());
  const filtered = filterRagResults(deduped);
  const totalChunks = filtered.flatMap((d) => d.chunks).length;

  clog.log("RAG", `Results — raw: ${rawResults.flat().length}, after dedup+filter: ${totalChunks} chunks`);

  return {
    rag_results: filtered,
    rag_formated: formatRagResults(filtered),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS — Definition & execution
// ─────────────────────────────────────────────────────────────────────────────

const getTools = (includeTools: string[]): Tool[] => {
  const tools: Tool[] = [
    {
      type: "function",
      function: {
        name: "get_current_date",
        description: "Retrieve the current date and time",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_knowledge",
        description: "Search internal knowledge base / documents for relevant information",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language search query" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information using a text query. Returns title, url, short content.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Retrieve the full content of a specific web page by URL",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full URL of the web page" },
          },
          required: ["url"],
        },
      },
    },
  ];

  return tools.filter(tool => tool.function.name ? tool.function.name in includeTools : false);
}

const getCurrentDate = (): string => {
  return new Date().toISOString();
};

const getKnowledge = async (
  query: string,
  node: ComputeNode,
  model:string,
  limit: number,
  advanced: boolean
) : Promise<{ rag_results: DocumentRow[]; rag_formated: string }> => {
  const knowledge = Knowledge.instance;

  let results: DocumentRow[];
  if (advanced) {
    results = await knowledge.searchWithRerank(query, node, model, limit * 2, limit);
  } else {
    results = await knowledge.search(query, node, limit);
  }

  const filtered = filterRagResults(results);
  const formatted = formatRagResults(filtered);

  if (!formatted) {
    return {rag_results: [], rag_formated: "No relevant documents found for the given query."};
  }

  return {rag_results: filtered, rag_formated: formatted};
}

// ─────────────────────────────────────────────────────────────────────────────
// AI — Message streaming (agent loop)
// ─────────────────────────────────────────────────────────────────────────────

const truncateRagToFitContext = (
  ragMessage: OllamaMessage,
  availableTokens: number,
  clog: ReturnType<typeof createLogger>
): OllamaMessage => {
  const truncatedWarning = "\n[RAG truncated due to context limit]";
  const enc = encoding_for_model("gpt-4");
  const encoded = enc.encode(ragMessage.content);
  const truncated = encoded.slice(0, availableTokens - countTokens(truncatedWarning));
  const decoded = new TextDecoder().decode(enc.decode(truncated));

  clog.warn("Stream", `RAG truncated from ${encoded.length} to ${truncated.length} tokens`);
  return { ...ragMessage, content: decoded + truncatedWarning };
};

const buildMessageContext = (
  systemMessage: OllamaMessage,
  ragMessage: OllamaMessage | null,
  chatHistory: OllamaMessage[],
  userContent: string
): OllamaMessage[] => {
  const messages: OllamaMessage[] = [
    systemMessage,
    ...chatHistory,
    { role: "user", content: userContent },
  ];
  if (ragMessage) messages.splice(1, 0, ragMessage);
  return messages;
};

const streamAIMessage = async (
  content: string,
  systemMessage: OllamaMessage,
  chatHistory: OllamaMessage[],
  rag: {limit: number, use_advanced: boolean, use_web_search: boolean},
  node: ComputeNode,
  model: string,
  res: Response,
  clog: ReturnType<typeof createLogger>
): Promise<string> => {
  const MAX_RESPONSE_TOKENS = 1000;
  const MAX_TOOL_ITERATIONS = 10;

  const neededTools = ["get_current_date", "get_knowledge"];
  if (rag.use_web_search) {
    neededTools.push("web_search", "web_fetch");
  }
  const tools = getTools(neededTools);

  let messages = buildMessageContext(systemMessage, null, chatHistory, content);

  clog.log("Stream", `Starting agent loop — model: ${model}`);

  let finalContent = "";
  let iteration = 0;
  let lastState: string | null = null;
  let completeRag: DocumentRow[] = [];

  // ── Agent loop ────────────────────────────────────────────────────────────
  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    const isLastIteration = iteration - 1 === MAX_TOOL_ITERATIONS;
    clog.log("Stream", `Agent loop iteration ${iteration}`);

    let thinking = "";
    let content = "";
    const toolCalls: ToolCall[] = [];

    const completeMessagesTexts = messages.map((m) => m.content).join("\n")
    let num_ctx = countTokens(completeMessagesTexts) + MAX_RESPONSE_TOKENS;

    for await (const chunk of runOllamaStream(node.id, model, messages, {
      think: true,
      num_ctx,
      temperature: 0.4,
      tools: !isLastIteration ? tools : undefined,
    })) {
      if (chunk.thinking) {
        thinking += chunk.thinking;
        streamWrite(res, { generated_think: chunk.thinking });
      }

      if (chunk.content) {
        content += chunk.content;
        streamWrite(res, { generated_chunk: chunk.content });
      }

      if (chunk.tool_calls.length) {
        toolCalls.push(...chunk.tool_calls);
      }

      const currentState = (thinking && !content && !toolCalls.length)
        ? "thinking"
        : "generating";

      if (currentState !== lastState) {
        lastState = currentState;
        streamWrite(res, { generation_state: currentState });
      }
    }

    if (thinking || content || toolCalls.length) {
      messages.push({ role: 'assistant', thinking, content, tool_calls: toolCalls })
    }

    streamWrite(res, { generated_think: "\n<end-iteration />\n" });

    // ── No tool calls → model is done ─────────────────────────────────────
    if (toolCalls.length === 0) {
      finalContent = content;
      clog.log("Stream", `No tool calls — agent loop complete after ${iteration} iteration(s)`);
      break;
    }

    // ── Execute tool calls ─────────────────────────────────────────────────
    streamWrite(res, { generation_state: "executing_tools" });
    clog.log("Stream", `Executing ${toolCalls.length} tool call(s)`);

    for (const call of toolCalls) {
      if (call.function.name === "get_current_date") {
        const result = getCurrentDate();
        messages.push({ role: 'tool', tool_name: call.function.name, content: result } )
        clog.log("Stream", `Executed tool call: ${call.function.name} - ${result}`);
      } else if (call.function.name === "get_knowledge") {
        streamWrite(res, { generation_state: "preparing_rag" });
        const args = call.function.arguments as { query: string }
        const result = await getKnowledge(args.query, node, model, rag.limit, rag.use_advanced);
        messages.push({ role: 'tool', tool_name: call.function.name, content: result.rag_formated } )

        if (result.rag_results.length > 0) {
          completeRag = [...completeRag, ...result.rag_results]
          completeRag = Knowledge.instance.deduplicateDocumentRows(completeRag);
          streamWrite(res, { rag_results: completeRag });
        }
        clog.log("Stream", `Executed tool call: ${call.function.name} - ${result.rag_results.flat().length} chars`);
        streamWrite(res, { generation_state: "executing_tools" });
      } else {
        messages.push({ role: 'tool', tool_name: call.function.name, content: 'Unknown tool' } )
        clog.warn("Stream", `Unknown tool call: ${call.function.name}`);
      }
    }

    streamWrite(res, { generation_state: "generating" });
  }

  if (iteration >= MAX_TOOL_ITERATIONS && !finalContent) {
    clog.warn("Stream", `Agent loop hit max iterations (${MAX_TOOL_ITERATIONS}), using last content`);
    finalContent = messages
      .filter((m) => m.role === "assistant" && m.content)
      .map((m) => m.content)
      .pop() ?? "Failed to generate a complete response.";
  }

  if (finalContent.trim() === "") {
    clog.warn("Stream", "Empty response received from model");
    finalContent = "Failed to generate message content. Please try again later.";
  }

  clog.log("Stream", `Agent loop done — ${finalContent.length} chars, ${iteration} iteration(s)`);
  return finalContent;
};

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLERS — Public route handlers
// ─────────────────────────────────────────────────────────────────────────────

export const createChat = async (req: Request, res: Response) => {
  try {
    const { title } = req.body;
    const user = (req as any).user;

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
    const user = (req as any).user;

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
    const user = (req as any).user;

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

export const postChatMessage = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { node_id, model, rag, content } = req.body as {
    node_id: number,
    model: string,
    rag: {limit: number, use_advanced: boolean, use_web_search: boolean},
    content: string};
  const user = (req as any).user;

  try {
    log("Chat", `Incoming message — chat: ${id}, model: ${model}, user: #${user.id}`);

    const node = await validateNodeStatus(Number(node_id));

    setupStreamingHeaders(res);
    streamWrite(res, { generation_state: "thinking" });

    const { chatId, isNewChat, chatObject } = await resolveChatSession(id, user.id);
    const clog = createLogger(chatId);

    let titlePromise: Promise<void> | undefined;
    if (isNewChat) {
      streamWrite(res, { chat: chatObject });

      titlePromise = (async () => {
        const title = await generateChatTitle(node.id, model, content).catch((err) => {
          clog.error("Chat", "Title generation failed, using fallback", err);
          return `Chat ${chatObject.id}`;
        });
        await pool.query(`UPDATE chats SET title = $1 WHERE id = $2`, [title, chatId]);
        chatObject.title = title;
        streamWrite(res, { chat: chatObject });
      })();
    }

    const systemMessage: OllamaMessage = {
      role: "system",
      content:
        "Your name is CerberusAI and you must help people in cybersecurity. " +
        "Use user's language as output. " +
        "When used something from RAG promote from with source it is. " +
        "You have access to tools: use get_current_date for date/time, " +
        "get_knowledge to search internal documents, " +
        "web_search to find current information on the web, " +
        "web_fetch to retrieve a specific web page. " +
        "Use tools whenever they would help answer the user's question more accurately.",
    };

    const history = await fetchChatHistory(chatId);
    const userMessage = await saveMessage(chatId, "user", user.id, content);
    streamWrite(res, { message: userMessage });

    let ragMessage: OllamaMessage | null = null;
    // if (Number(rag_limit) > 0) {
    //   streamWrite(res, { generation_state: "preparing_rag" });
    //   clog.log("RAG", `Retrieving context — limit: ${rag_limit}, advanced: ${rag_advanced}`);
    //
    //   const ragContext: OllamaMessage[] = [...history, { role: "user", content }];
    //   const rag = await getRag(ragContext, Number(rag_limit), Boolean(rag_advanced), node, model, clog);
    //
    //   ragMessage = {
    //     role: "system",
    //     content: `Use these information's (RAG) if relevant: ${rag.rag_formated}`,
    //   };
    //
    //   if (rag.rag_results.length > 0) {
    //     streamWrite(res, { rag_results: rag.rag_results });
    //   }
    // }

    streamWrite(res, { generation_state: "generating" });
    const generatedContent = await streamAIMessage(
      content, systemMessage, history, rag, node, model, res, clog
    );

    const aiMessage = await saveMessage(chatId, "ai", null, generatedContent);
    streamWrite(res, { generated_message: aiMessage });

    if (titlePromise) await titlePromise;

    clog.log("Chat", `Message exchange complete`);
    res.end();
  } catch (err: any) {
    error("Chat", `postChatMessage failed — chat ${id}`, { message: err.message, stack: err.stack });
    streamWrite(res, { error: err.message });
    res.end();
  }
};

export const deleteChat = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;

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