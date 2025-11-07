import fetch from "node-fetch";
import {checkOnline} from "../controllers/computeNodeController";
import {getNodeById, buildOllamaUrl} from "../controllers/ollamaController";

export interface OllamaMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function runOllamaSync(
  nodeId: number,
  model: string,
  session: string,
  messages: OllamaMessage[]
): Promise<{ content: string; done: boolean }> {
  const node = await getNodeById(nodeId);
  const status = await checkOnline(node.ip, node.port);
  if (status === "offline") {
    throw new Error("Node is offline");
  }

  const keep_alive = Number(process.env.MODEL_KEEPALIVE) || 300;

  const response = await fetch(`${buildOllamaUrl(node)}/api/chat`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      model,
      session,
      messages,
      keep_alive
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}`);
  }

  if (!response.body) {
    throw new Error("No response body from Ollama");
  }

  const text = await response.text();
  const lines = text.trim().split('\n');
  const parsed_lines = lines.map(line => JSON.parse(line));
  const content = parsed_lines.map(line => line.message.content).join("")

  return {content: content, done: parsed_lines[parsed_lines.length - 1].done};
}

export async function* runOllamaStream(
  nodeId: number,
  model: string,
  session: string,
  messages: OllamaMessage[]
): AsyncGenerator<{ content: string; done: boolean }> {
  const node = await getNodeById(nodeId);
  const status = await checkOnline(node.ip, node.port);

  if (status === "offline") {
    throw new Error("Node is offline");
  }

  const keep_alive = Number(process.env.MODEL_KEEPALIVE) || 300;

  const response = await fetch(`${buildOllamaUrl(node)}/api/chat`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      model,
      session,
      messages,
      keep_alive,
    }),
  });

  if (!response.body) {
    throw new Error("No response body from Ollama");
  }

  let buffer = "";

  for await (const chunk of response.body) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        yield {
          content: parsed?.message?.content || "",
          done: parsed?.done || false,
        };
      } catch (err) {
        console.error("Parse error:", err);
      }
    }
  }

  if (buffer.trim()) {
    try {
      const parsed = JSON.parse(buffer);
      yield {
        content: parsed?.message?.content || "",
        done: parsed?.done || false,
      };
    } catch {
    }
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