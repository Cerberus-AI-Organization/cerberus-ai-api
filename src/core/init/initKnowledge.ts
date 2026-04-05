import {Knowledge} from "../rag/knowledge";
import {crawlWeb} from "../rag/tools/crawler";
import {parsePDF} from "../rag/tools/pdfparser";
import { join } from "path";
import {existsSync, readFileSync} from "node:fs";
import {ComputeNode} from "../../types/computeNode";
import {pool} from "../database";
import {DocumentPage} from "../rag/types";

type KnowledgeSources = {
  sites: string[],
  documents: string[],
}

const SOURCES_PATH = join(process.cwd(), "data", "knowledge.json");

function loadSources(): KnowledgeSources {
  try {
    if (!existsSync(SOURCES_PATH)) {
      console.warn(`Warning: ${SOURCES_PATH} not found. Using empty sources.`);
      return { sites: [], documents: [] };
    }
    const rawData = readFileSync(SOURCES_PATH, "utf-8");
    return JSON.parse(rawData);
  } catch (err) {
    console.error("Error reading sources.json:", err);
    return { sites: [], documents: [] };
  }
}

async function getAvailableNode(): Promise<ComputeNode> {
  const res = await pool.query(
    "SELECT * FROM compute_nodes WHERE status = 'online' ORDER BY priority DESC LIMIT 1"
  );
  const node = res.rows[0];
  if (!node) throw new Error("No online compute node found");
  return node;
}

export async function syncKnowledge() {
  const knowledge = Knowledge.instance;
  const { sites, documents } = loadSources();

  for (const doc of documents) {
    const node = await getAvailableNode();
    if (!node) throw new Error("No online compute node found");
    console.log(`[Knowledge] Using node: ${node.hostname} (${node.url}) for document: ${doc}`);

    console.log(`[Knowledge] Started Parsing of Document (${doc})`);
    try {
      if (doc.endsWith(".pdf")) {
        const pages = await parsePDF(join(process.cwd(), "data", doc));
        const documentPages: DocumentPage[] = []
        pages.forEach((page, index) => {
          documentPages.push({
            text: page,
            source: `${doc} Page ${index + 1}`,
          })
        })
        await knowledge.addDocument(documentPages, doc, {
          name: doc,
          type: "pdf"
        }, node);
      } else {
        console.log("Not Supported: ", doc, " - must be .pdf file extension. Skipping...")
      }
    } catch (err) {
      console.error(`Failed to Ingest Document [${doc}]:`, err);
    }
  }

  for (const site of sites) {
    const node = await getAvailableNode();
    if (!node) throw new Error("No online compute node found");
    console.log(`[Knowledge] Using node: ${node.hostname} (${node.url}) for site: ${site}`);

    console.log(`[Knowledge] Started Crawl (${site})`);
    try {
      for await (const page of crawlWeb(site)) {
        const documentPage: DocumentPage = {
          text: page.text,
          source: page.url
        }

        try {
          await knowledge.addDocument([documentPage], documentPage.source, {
            type: "web"
          }, node);
        } catch (err) {
          console.error(`Failed to add document [${documentPage.source}]:`, err);
        }
      }
    } catch (err) {
      console.error(`Failed to Crawl [${site}]:`, err);
    }
  }
}

export async function initKnowledge() {
  await Knowledge.instance.init();
  console.log("Knowledge singleton initialized.");

  await syncKnowledge();
}