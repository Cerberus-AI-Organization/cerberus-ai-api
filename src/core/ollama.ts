import {Ollama, Tool, ToolCall, Message} from "ollama";
import { checkOnline } from "../controllers/computeNodeController";
import { getNodeById } from "../controllers/ollamaController";
import {ComputeNode} from "../types/computeNode";
import {encoding_for_model} from "tiktoken";

export interface OllamaMessage extends Message {}

export function buildOllamaUrl(ip: string, port: number) {
  if (ip.includes("http://") || ip.includes("https://")) {
    return `${ip}:${port}`;
  }
  return `http://${ip}:${port}`;
}

export function createOllamaClient(baseUrl: string) {
  return new Ollama({ host: baseUrl });
}

export function createOllamaClientFromNode(node: ComputeNode) {
  return createOllamaClient(buildOllamaUrl(node.ip, node.port));
}

export async function haveModel(node: ComputeNode, model: string) {
  const ollama = createOllamaClientFromNode(node);
  const models = await ollama.list();
  return models.models.some(m => m.name === model);
}

export async function getModelsMaxCtx(model: string): Promise<number | null> {
  try {
    const baseModel = model.split(":")[0];
    const url = `https://ollama.com/library/${baseModel}`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const html = await res.text();
    const match = html.match(/(\d+(?:\.\d+)?)([KMB]?)\s*context window/i);
    if (!match) return null;

    let value = parseFloat(match[1]);
    const unit = match[2]?.toUpperCase();

    if (unit === "K") value *= 1024;
    if (unit === "M") value *= 1024 * 1024;
    if (unit === "B") value *= 1024 * 1024 * 1024;

    return Math.round(value);
  } catch (error) {
    console.error(`Error fetching model ctx for ${model}:`, error);
    return null;
  }
}

export async function getMaxCtx(node: ComputeNode, model: string): Promise<number> {
  const maxCtx = await getModelsMaxCtx(model);
  if (!maxCtx) return node.max_ctx;

  if (model.includes("cloud")) {
    return maxCtx;
  }

  return Math.min(maxCtx, node.max_ctx);
}

export function countTokens(text: string): number {
  const enc = encoding_for_model("gpt-4");
  return enc.encode(text).length;
}

export function roundCtx(ctx: number, maxValue: number): number {
  if (ctx <= 0) return 0;
  const rounded = Math.pow(2, Math.ceil(Math.log2(ctx)));
  return Math.min(rounded, maxValue);
}

export function truncateMessagesToFit(messages: OllamaMessage[], maxCtx: number): OllamaMessage[] {
  const result = messages.map(m => ({ ...m }));

  while (true) {
    const totalTokens = result.reduce((acc, msg) => acc + countTokens(msg.content), 0);
    if (totalTokens <= maxCtx) break;

    const overflow = totalTokens - maxCtx;

    // Find longest non-system message
    let longestIdx = -1;
    let longestTokens = 0;
    for (let i = 0; i < result.length; i++) {
      if (result[i].role === "system") continue;
      const tokens = countTokens(result[i].content);
      if (tokens > longestTokens) {
        longestTokens = tokens;
        longestIdx = i;
      }
    }

    if (longestIdx === -1) break; // Only system messages remain, nothing to truncate

    // Trim `overflow` tokens from the beginning of the message content
    const enc = encoding_for_model("gpt-4");
    const encoded = enc.encode(result[longestIdx].content);
    const trimCount = Math.min(overflow + 50, encoded.length); // +50 buffer to avoid tight loops
    const trimmed = encoded.slice(trimCount);
    result[longestIdx] = {
      ...result[longestIdx],
      content: new TextDecoder().decode(enc.decode(trimmed)),
    };

    // If message is now empty, remove it entirely
    if (!result[longestIdx].content.trim()) {
      result.splice(longestIdx, 1);
    }

    result[longestIdx].content += "[Message truncated because of context limit exceeded.]";
  }

  return result;
}

export interface RunOllamaOptions {
  tools?: Tool[];
  think?: boolean | "high" | "medium" | "low";
  num_ctx?: number;
  temperature?: number;
  num_predict?: number;
}

interface PreparedOllamaChat {
  ollama: Ollama;
  ctx: number | undefined;
  keep_alive: number;
  node: ComputeNode;
}

async function prepareOllamaChat(
  nodeId: number,
  model: string,
  messages: OllamaMessage[],
  options: RunOllamaOptions
): Promise<{ prepared: PreparedOllamaChat; messages: OllamaMessage[] }> {
  const node = await getNodeById(nodeId);
  const status = await checkOnline(node.ip, node.port);

  if (status === "offline") {
    throw new Error("Node is offline");
  }

  const keep_alive = Number(process.env.MODEL_KEEPALIVE) || 300;
  const ollama = createOllamaClientFromNode(node);
  const max_ctx = await getMaxCtx(node, model);
  const ctx = options.num_ctx ? roundCtx(options.num_ctx, max_ctx) : undefined;

  const neededCtx = messages.reduce((acc, msg) => acc + countTokens(msg.content), 0);
  console.log(`Ollama ctx: ${ctx} (needed: ${neededCtx} + response) | model: ${model} | node: ${node.hostname}`);

  const effectiveMax = ctx ?? max_ctx;
  const truncatedMessages = neededCtx > effectiveMax
    ? truncateMessagesToFit(messages, effectiveMax)
    : messages;

  if (truncatedMessages !== messages) {
    const newTotal = truncatedMessages.reduce((acc, msg) => acc + countTokens(msg.content), 0);
    console.warn(`Messages truncated: ${neededCtx} → ${newTotal} tokens`);
  }

  return {
    prepared: { ollama, ctx, keep_alive, node },
    messages: truncatedMessages,
  };
}

export async function runOllamaSync(
  nodeId: number,
  model: string,
  messages: OllamaMessage[],
  options: RunOllamaOptions = {}
): Promise<{ content: string; thinking: string; tool_calls: ToolCall[]; done: boolean }> {
  const { prepared, messages: msgs } = await prepareOllamaChat(nodeId, model, messages, options);
  const { ollama, ctx, keep_alive, node } = prepared;

  const response = await ollama.chat({
    model,
    messages: msgs,
    keep_alive,
    stream: false,
    think: options.think,
    tools: options.tools,
    options: {
      num_ctx: ctx,
      num_gpu: node.max_layers_on_gpu,
      temperature: options.temperature,
      num_predict: options.num_predict,
    },
  }).catch(err => {
    console.error("Error running Ollama sync", err);
    throw err;
  });

  return {
    content: response.message?.content ?? "",
    thinking: response.message?.thinking ?? "",
    tool_calls: response.message?.tool_calls ?? [],
    done: true,
  };
}

export async function* runOllamaStream(
  nodeId: number,
  model: string,
  messages: OllamaMessage[],
  options: RunOllamaOptions = {}
): AsyncGenerator<{ content: string; thinking: string; tool_calls: ToolCall[]; done: boolean }> {
  const { prepared, messages: msgs } = await prepareOllamaChat(nodeId, model, messages, options);
  const { ollama, ctx, keep_alive, node } = prepared;

  const stream = await ollama.chat({
    model,
    messages: msgs,
    keep_alive,
    stream: true,
    think: options.think,
    tools: options.tools,
    options: {
      num_ctx: ctx,
      num_gpu: node.max_layers_on_gpu,
      temperature: options.temperature,
      num_predict: options.num_predict,
    },
  }).catch(err => {
    console.error("Error running Ollama stream", err);
    throw err;
  });

  for await (const chunk of stream) {
    yield {
      content: chunk.message?.content ?? "",
      thinking: chunk.message?.thinking ?? "",
      tool_calls: chunk.message?.tool_calls ?? [],
      done: chunk.done ?? false,
    };
  }
}

export function getCerberusAISystemPrompt() {
  return `
        # 🛡️ CerberusAI – Advanced Cybersecurity Intelligence Assistant
        
        ## Role & Purpose
        You are **CerberusAI**, a specialized AI system focused on cybersecurity defense, threat analysis, and incident response.
        Your core objective is to help users secure their digital environments, detect and analyze threats, and ensure compliance with cybersecurity standards.
        You act as a **defensive strategist, threat analyst, and compliance advisor**.
        
        ---
        
        ## Core Capabilities
        
        ### 1. Threat Detection & Analysis
        - Identify and classify vulnerabilities, malware, phishing attempts, and attack vectors.
        - Analyze network traffic, logs, and endpoints for anomalies or intrusions.
        - Recommend and explain security tools (SIEM, EDR, IDS/IPS, XDR).
        - Use frameworks like **MITRE ATT&CK**, **CVE/NVD**, and **Cyber Kill Chain** to inform threat intelligence.
        
        ### 2. Incident Response & Mitigation
        - Provide structured, step-by-step playbooks for incidents such as ransomware, DDoS, insider threats, or breaches.
        - Guide through **containment, eradication, recovery, and forensic analysis**.
        - Recommend **logging, communication, and escalation** best practices.
        - Deliver **post-incident review** and continuous improvement recommendations.
        
        ### 3. Security Architecture & Best Practices
        - Advise on **firewall configuration**, **WAFs**, **zero-trust models**, **network segmentation**, and **endpoint hardening**.
        - Recommend **encryption**, **MFA**, **RBAC/ABAC**, and **key management** best practices.
        - Promote **secure coding**, **patch management**, and **CIS / DISA STIG baseline compliance**.
        
        ### 4. Compliance & Governance
        - Align controls with **NIST CSF**, **ISO 27001**, **GDPR**, **HIPAA**, and **SOC 2** frameworks.
        - Draft or evaluate **security policies**, **incident response plans**, and **risk management** strategies.
        - Advise on **data protection**, **privacy compliance**, and **third-party governance**.
        
        ### 5. Ethical Hacking & Red Teaming
        - Simulate **controlled penetration testing** and **red team exercises** to assess system resilience.
        - Suggest **ethical hacking tools and frameworks** (e.g., Nmap, Burp Suite, Metasploit, Wireshark, BloodHound).
        - Always clarify authorization and stay within **legal and ethical boundaries**.
        
        ---
        
        ## Interaction Guidelines
        - 🧭 **Defense First:** Always prioritize defensive, preventive, and mitigation strategies.
        - 🔍 **Context-Aware:** Request user context (OS, network type, tools in use) before technical recommendations.
        - 🔒 **Legally Compliant:** Never assist in illegal or unethical hacking, exploitation, or harm.
        - ⚙️ **Actionable Guidance:** Provide clear, concise, and step-by-step instructions.
        - 📈 **Proactive & Adaptive:** Anticipate risks and recommend preemptive controls.
        - 🧠 **Current Intelligence:** Base advice on recent threat data, CVEs, and frameworks.
        - 🗣️ **Clear Communication:** Avoid unnecessary jargon; define technical terms when used.
  `
}