import * as lancedb from "@lancedb/lancedb";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ComputeNode } from "../../types/computeNode";
import { DocumentChunker } from "./documentChunker";
import { DocumentEmbedder, EMBED_DIM } from "./documentEmbedder";
import {ChunkRow, DocumentPage, DocumentRow, IndexedSource} from "./types";
import {DocumentReranker, RerankedChunk} from "./documentReranker";

export const KNOWLEDGE_SYNC_HOURS: number[] = (() => {
  const val = process.env.KNOWLEDGE_SYNC_HOURS ?? "0";
  if (val === "-1") return [];
  return val
    .split(",")
    .map(h => parseInt(h.trim(), 10))
    .filter(h => !isNaN(h) && h >= 0 && h <= 23);
})();

export class Knowledge {
  static #instance: Knowledge;

  private db: any;
  private table: any;

  private readonly chunker = new DocumentChunker();
  private readonly embedder = new DocumentEmbedder();
  private readonly reranker = new DocumentReranker();

  public static get instance(): Knowledge {
    if (!Knowledge.#instance) {
      Knowledge.#instance = new Knowledge();
    }
    return Knowledge.#instance;
  }

  async init() {
    this.db = await lancedb.connect("./data/vector_db");

    const tableNames:string[] = await this.db.tableNames();

    if (tableNames.includes("knowledge")) {
      this.table = await this.db.openTable("knowledge");
      await this.migrateSchema();
    } else {
      this.table = await this.db.createTable("knowledge", [
        {
          vector: new Array(EMBED_DIM).fill(0),
          text: "init",
          source: "init",
          page_source: "init",
          hash: "init",
          metadata: "{}",
          added_at: 0,
        },
      ]);
    }
  }

  private async migrateSchema() {
    let somethingChanged = false;

    try {
      await this.table.query().select(["added_at"]).limit(1).toArray();
    } catch {
      console.log("[Knowledge] Migrating schema: Adding added_at column");
      await this.table.addColumns([
        { name: "added_at", valueSql: "0" },
      ])
      somethingChanged = true;
    }

    if (somethingChanged) {
      console.log("[Knowledge] Migration complete");
    }
  }

  async addDocument(pages: DocumentPage[], source: string, metadata: any = {}, node: ComputeNode) {
    const completeText = pages.map((p) => p.text).join("\n\n\n");
    this.saveCompleteText(completeText, source);

    const hash = this.hash(completeText);
    const existing = await this.table.query().where(`source = '${source}'`).limit(1).toArray();

    if (existing.length > 0) {
      if (existing[0].hash === hash) {
        console.log(`[Knowledge] Skipping "${source}" (unchanged)`);
        return;
      }

      const age = Date.now() - Number(existing[0].added_at ?? 0)
      const ttl = 1000 * 60 * 60 * 4;
      if (age < ttl) {
        console.log(`[Knowledge] Skipping "${source}" (too new, ${(age/1000)/60}min)`);
        return;
      }

      console.log(`[Knowledge] Updating "${source}"`);
      await this.table.delete(`source = '${source}'`);
    }

    if (node.status !== "online") {
      console.log(`[Knowledge] Skipping "${source}" (node offline)`);
      return;
    }

    const chunks = this.chunker.createChunks(pages, source);
    const metadataStr = JSON.stringify(metadata);

    const BATCH_SIZE = 10;
    let batch = [];

    for (const [i, chunk] of chunks.entries()) {
      batch.push({
        vector: await this.embedder.embed(chunk.text, node),
        text: chunk.text,
        source,
        page_source: chunk.page_source,
        hash,
        metadata: metadataStr,
        added_at: Date.now(),
      });
      console.log(`[Knowledge] Embedded ${i + 1}/${chunks.length} chunks`);

      if (batch.length >= BATCH_SIZE) {
        await this.table.add(batch);
        batch = [];
      }
    }

    if (batch.length > 0) await this.table.add(batch);
    console.log(`[Knowledge] Added "${source}" → ${chunks.length} chunks`);
  }

  async search(
    query: string,
    node: ComputeNode,
    chunkLimit = 10
  ): Promise<DocumentRow[]> {
    console.log(`[Knowledge] Searching for "${query}"`);
    const queryVector = await this.embedder.embed(query, node);
    let vectorChunks = await this.table
      .search(queryVector)
      .limit(chunkLimit)
      .toArray();
    vectorChunks = vectorChunks.filter((vc: any) => vc.source !== "init");

    console.log(`[Knowledge] Found ${vectorChunks.length} chunks for "${query}"`);

    if (!vectorChunks.length) return [];

    return this.groupChunksBySource(vectorChunks);
  }

  async searchWithRerank(query: string, node: ComputeNode, model: string, chunkLimit = 10, topK = 5): Promise<DocumentRow[]> {
    const queryVector = await this.embedder.embed(query, node);
    let vectorChunks = await this.table
      .search(queryVector)
      .limit(chunkLimit)
      .toArray();
    vectorChunks = vectorChunks.filter((vc: any) => vc.source !== "init");

    console.log(`[Knowledge] Found ${vectorChunks.length} chunks for "${query}"`);
    if (!vectorChunks.length) return [];


    const chunks:RerankedChunk[] = vectorChunks.map((vc:any) => ({ text: vc.text, source: vc.source, page_source: vc.page_source, score: vc._distance }));
    const reranked = await this.reranker.rerank(
      query, chunks, node, model, topK
    );

    console.log(`[Knowledge] Reranked to ${reranked.length} chunks`);

    return this.groupChunksBySourceRerank(reranked, vectorChunks);
  }

  async isEmpty(): Promise<boolean> {
    const entries = await this.table.query().select(["source"]).limit(2).toArray();
    return entries.every((e: any) => e.source === "init");
  }

  async getAllIndexedSources(): Promise<IndexedSource[]> {
    const entries = await this.table
      .query()
      .select(["source", "hash", "metadata", "page_source"])
      .toArray();

    const grouped = new Map<string, IndexedSource>();

    for (const entry of entries) {
      if (entry.source === "init") continue;

      if (!grouped.has(entry.source)) {
        grouped.set(entry.source, {
          source: entry.source,
          hash: entry.hash,
          metadata: typeof entry.metadata === "string" ? JSON.parse(entry.metadata) : entry.metadata,
          chunksCount: 0,
          chunks: [],
        });
      }

      const record = grouped.get(entry.source)!;
      record.chunksCount++;
      record.chunks.push({ text: entry.text, source: entry.source, page_source: entry.page_source });
    }

    return Array.from(grouped.values());
  }

  private groupChunksBySourceRerank(reranked: RerankedChunk[], vectorChunks: any[]): DocumentRow[] {
    const grouped = new Map<string, DocumentRow>();

    for (const chunk of reranked) {
      const original = vectorChunks.find(
        (vc: any) => vc.text === chunk.text && vc.source === chunk.source
      );

      if (!original) continue;

      if (!grouped.has(chunk.source)) {
        grouped.set(chunk.source, {
          source: chunk.source,
          hash: original.hash,
          metadata: typeof original.metadata === "string" ? JSON.parse(original.metadata) : original.metadata,
          chunks: [],
        });
      }

      grouped.get(chunk.source)!.chunks.push({
        text: chunk.text,
        page_source: chunk.page_source,
        score: chunk.score,
      });
    }

    return Array.from(grouped.values());
  }

  private groupChunksBySource(vectorChunks: any[]): DocumentRow[] {
    const grouped = new Map<string, DocumentRow>();

    for (const vc of vectorChunks) {
      if (!grouped.has(vc.source)) {
        grouped.set(vc.source, {
          source: vc.source,
          hash: vc.hash,
          metadata:
            typeof vc.metadata === "string"
              ? JSON.parse(vc.metadata)
              : vc.metadata,
          chunks: [],
        });
      }

      grouped.get(vc.source)!.chunks.push({
        text: vc.text,
        page_source: vc.page_source,
        score: vc._distance ?? vc.score ?? null,
      });
    }

    return Array.from(grouped.values());
  }

  private hash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
  }

  private saveCompleteText(text: string, source: string) {
    const filename = source.replace(/[^a-z0-9]/gi, "_").toLowerCase() + ".txt";
    const filepath = path.join(process.cwd(), "data", "texts", filename);
    fs.mkdirSync(path.join(process.cwd(), "data", "texts"), { recursive: true });
    fs.writeFileSync(filepath, text, "utf8");
  }

  public deduplicateDocumentRows = (results: DocumentRow[]): DocumentRow[] => {
    const docs = new Map<string, DocumentRow>();

    for (const doc of results) {
      const key = doc.hash || doc.source;

      if (!docs.has(key)) {
        docs.set(key, {
          ...doc,
          chunks: [...doc.chunks],
        });
        continue;
      }

      const existing = docs.get(key)!;

      const chunkMap = new Map<string, ChunkRow>();

      for (const chunk of existing.chunks) {
        chunkMap.set(chunk.text, chunk);
      }

      for (const chunk of doc.chunks) {
        const prev = chunkMap.get(chunk.text);

        if (!prev || chunk.score > prev.score) {
          chunkMap.set(chunk.text, chunk);
        }
      }

      existing.chunks = Array.from(chunkMap.values());
    }

    for (const doc of docs.values()) {
      doc.chunks.sort((a, b) => b.score - a.score);
    }

    return Array.from(docs.values());
  };

}