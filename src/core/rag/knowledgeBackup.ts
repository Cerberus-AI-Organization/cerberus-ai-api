import * as lancedb from "@lancedb/lancedb";
import {createOllamaClientFromNode, haveModel} from "../ollama";
import {ComputeNode} from "../../types/computeNode";
import * as crypto from "crypto";

export class Knowledge {
  static #instance: Knowledge;
  private db: any;
  private table: any;

  public static get instance(): Knowledge {
    if (!Knowledge.#instance) {
      Knowledge.#instance = new Knowledge();
    }
    return Knowledge.#instance;
  }

  async init() {
    this.db = await lancedb.connect("./data/vector_db");

    try {
      this.table = await this.db.openTable("knowledge");
    } catch {
      this.table = await this.db.createTable("knowledge", [
        {
          vector: new Array(768).fill(0),
          text: "init",
          source: "init",
          page_source: "init",
          hash: "init",
          metadata: "{}"
        }
      ]);
    }
  }

  private calculateHash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private async createSemanticChunks(
    pages: DocumentPage[],
    node: ComputeNode,
    maxChars = 3000,
    similarityThreshold = 0.70
  ): Promise<{ text: string, page_source: string }[]> {

    type BaseUnit = { text: string, page_source: string, vector?: number[] };
    const baseUnits: BaseUnit[] = [];

    let currentHeading = ""; // Zde si budeme pamatovat aktuální paragraf

    for (const page of pages) {
      // Čištění a oprava seznamů (a), b), c)...)
      const cleanedText = page.text.replace(/(?<![\.\:\?\!\;\,\-])\n(?!\n)(?!\s*[a-z]\))(?!\s*\([0-9]+\))/g, ' ');
      const rawUnits = cleanedText.split(/\n+/);

      for (const unit of rawUnits) {
        const trimmed = unit.trim();

        // Detekce nadpisu (Hledáme něco co začíná na "§" nebo "# §" nebo "### §")
        if (trimmed.match(/^(#+\s*)?§\s*[\*\d]+/)) {
          currentHeading = trimmed; // Uložíme si nadpis pro další odstavce
        }

        if (trimmed.length > 10) {
          // Pokud to NENÍ samotný nadpis, ale máme nějaký nadpis uložený, přilepíme ho na začátek
          let enrichedText = trimmed;
          if (currentHeading && trimmed !== currentHeading && !trimmed.startsWith(currentHeading)) {
            enrichedText = `${currentHeading}\n${trimmed}\n`;
          }

          baseUnits.push({
            text: enrichedText,
            page_source: page.source
          });
        }
      }
    }

    if (baseUnits.length === 0) return [];

    console.log(`[Knowledge] Získáno ${baseUnits.length} základních jednotek (s kontextem nadpisů). Počítám vektory...`);

    // ❗ TADY JE TEN CHYBĚJÍCÍ KROK ❗
    // Získání vektorů pro každou jednotku z Ollamy
    for (let i = 0; i < baseUnits.length; i++) {
      baseUnits[i].vector = await this.embed(baseUnits[i].text, node);
    }

    const chunks: { text: string, page_source: string }[] = [];

    // Bezpečná pomocná funkce pro vyčištění textu před spojením (bez použití Regexu)
    const cleanUnitForMerge = (unitText: string, heading: string) => {
      if (heading && unitText.startsWith(heading)) {
        // Odřízne nadpis a smaže prázdné znaky/odřádkování za ním
        return unitText.slice(heading.length).trim();
      }
      return unitText;
    };

    let currentChunkText = cleanUnitForMerge(baseUnits[0].text, currentHeading);
    let currentChunkPages = new Set<string>([baseUnits[0].page_source]);
    let currentFocusVector = baseUnits[0].vector!;
    let lastSeenHeading = "";

    // Pokud první jednotka měla v sobě nadpis, uložíme si ho
    if (baseUnits[0].text.startsWith("### §") || baseUnits[0].text.match(/^(#+\s*)?§/)) {
      lastSeenHeading = baseUnits[0].text.split("\n")[0];
    }

    for (let i = 1; i < baseUnits.length; i++) {
      const unit = baseUnits[i];

      // Zjistíme nadpis aktuální jednotky (pokud ho má přilepený)
      const unitLines = unit.text.split("\n");
      if (unitLines[0].startsWith("### §") || unitLines[0].match(/^(#+\s*)?§/)) {
        lastSeenHeading = unitLines[0];
      }

      // Nyní počítáme vzdálenost (vektory už 100% existují)
      const similarity = this.cosineSimilarity(currentFocusVector, unit.vector!);

      // Hledáme čistý text bez opakujícího se nadpisu
      const cleanText = cleanUnitForMerge(unit.text, lastSeenHeading);

      if (similarity >= similarityThreshold && (currentChunkText.length + cleanText.length) < maxChars) {
        // Spojujeme čisté texty k sobě
        if (cleanText) {
          // Zabráníme prázdným řádkům navíc
          currentChunkText += (currentChunkText.length > 0 ? "\n" : "") + cleanText;
        }
        currentChunkPages.add(unit.page_source);
        currentFocusVector = unit.vector!;
      } else {
        // Sémantický zlom: Uložíme aktuální chunk
        const pagesArray = Array.from(currentChunkPages);

        // TADY PŘIDÁME NADPIS POUZE JEDNOU NA ZAČÁTEK CELÉHO BLOKU
        const finalText = lastSeenHeading ? `${lastSeenHeading}\n${currentChunkText.trim()}` : currentChunkText.trim();

        chunks.push({
          text: finalText,
          page_source: pagesArray.length === 1 ? pagesArray[0] : `${pagesArray[0]} - ${pagesArray[pagesArray.length - 1]}`
        });

        // Začneme nový chunk (opět vyčištěný)
        currentChunkText = cleanText;
        currentChunkPages = new Set([unit.page_source]);
        currentFocusVector = unit.vector!;
      }
    }

    // Uložení posledního chunku
    if (currentChunkText.trim().length > 0) {
      const pagesArray = Array.from(currentChunkPages);
      const finalText = lastSeenHeading ? `${lastSeenHeading}\n${currentChunkText.trim()}` : currentChunkText.trim();

      chunks.push({
        text: finalText,
        page_source: pagesArray.length === 1 ? pagesArray[0] : `${pagesArray[0]} - ${pagesArray[pagesArray.length - 1]}`
      });
    }

    return chunks;
  }

  private async embed(text: string, node: ComputeNode) {
    const ollama = createOllamaClientFromNode(node);
    const embeddingModel = "nomic-embed-text:latest";

    if (!(await haveModel(node, embeddingModel))) {
      console.log(`[Knowledge] Pulling ${embeddingModel} model from ${node.hostname}`);
      await ollama.pull({model: embeddingModel});
      console.log(`[Knowledge] ${embeddingModel} model pulled from ${node.hostname}`);
    }

    const res = await ollama.embeddings({
      model: embeddingModel,
      prompt: text
    });
    return res.embedding;
  }

  private createChunksCrossPage(pages: DocumentPage[], maxChars = 3000, overlapChars = 400): {
    text: string,
    page_source: string
  }[] {
    let fullText = "";
    const pageBounds: { source: string, start: number, end: number }[] = [];

    for (const page of pages) {
      const cleanedText = page.text.replace(/(?<![\.\:\?\!\;\,\-])\n(?!\n)(?!\s*[a-z]\))(?!\s*\([0-9]+\))/g, ' ');

      const start = fullText.length;
      fullText += cleanedText + "\n\n";
      const end = fullText.length;

      pageBounds.push({source: page.source, start, end});
    }

    const chunks: { text: string, page_source: string }[] = [];
    let currentStartIndex = 0;

    while (currentStartIndex < fullText.length) {
      let chunkEndIndex = currentStartIndex + maxChars;

      if (chunkEndIndex >= fullText.length) {
        chunkEndIndex = fullText.length;
      } else {
        const searchWindow = fullText.substring(currentStartIndex, chunkEndIndex);

        let bestBreak = searchWindow.lastIndexOf("\n\n");

        if (bestBreak < searchWindow.length * 0.6) {
          bestBreak = searchWindow.lastIndexOf("\n");
        }

        if (bestBreak < searchWindow.length * 0.6) {
          const sentenceRegex = /(?<!\bodst|\bpísm|\bSb|\bčl|\btj|\btzv)\.\s/g;
          let match;
          let lastSafeSentence = -1;
          while ((match = sentenceRegex.exec(searchWindow)) !== null) {
            lastSafeSentence = match.index + 1; // +1 aby tečka zůstala v chunku
          }
          if (lastSafeSentence > searchWindow.length * 0.6) {
            bestBreak = lastSafeSentence;
          }
        }

        if (bestBreak < searchWindow.length * 0.6) {
          bestBreak = searchWindow.lastIndexOf(" ");
        }

        if (bestBreak > 0) {
          chunkEndIndex = currentStartIndex + bestBreak;
        }
      }

      const chunkText = fullText.substring(currentStartIndex, chunkEndIndex).trim();

      if (chunkText.length > 0) {
        const overlappingPages = pageBounds.filter(
          b => currentStartIndex < b.end && chunkEndIndex > b.start
        );

        let pageSource = "Neznámý zdroj";
        if (overlappingPages.length === 1) {
          pageSource = overlappingPages[0].source;
        } else if (overlappingPages.length > 1) {
          const first = overlappingPages[0].source;
          const last = overlappingPages[overlappingPages.length - 1].source;
          pageSource = `${first} - ${last}`;
        }

        chunks.push({
          text: chunkText,
          page_source: pageSource
        });
      }

      const prevStartIndex = currentStartIndex;
      let nextStartIndex = chunkEndIndex - overlapChars;

      const overlapSpace = fullText.indexOf(" ", nextStartIndex);
      if (overlapSpace !== -1 && overlapSpace < chunkEndIndex) {
        currentStartIndex = overlapSpace + 1;
      } else {
        currentStartIndex = chunkEndIndex;
      }

      if (currentStartIndex <= prevStartIndex) {
        currentStartIndex = chunkEndIndex;
      }
    }

    return chunks;
  }

  async addDocument(pages: DocumentPage[], source: string, metadata: any = {}, node: ComputeNode) {
    const completeText = pages.map(t => t.text).join("\n\n\n");
    const hash = this.calculateHash(completeText);

    const existing = await this.table
      .query()
      .where(`source = '${source}'`)
      .limit(1)
      .toArray();

    if (existing.length > 0) {
      if (existing[0].hash === hash) {
        console.log(`[Knowledge] Skipping ${source} (unchanged)`);
        return;
      }

      console.log(`[Knowledge] Updating ${source}`);
      await this.table.delete(`source = '${source}'`);
    }

    const rows = [];
    const metadataString = JSON.stringify(metadata);

    const chunksWithSource = await this.createSemanticChunks(pages, node);

    for (const item of chunksWithSource) {
      rows.push({
        vector: await this.embed(item.text, node),
        text: item.text,
        source: source,
        page_source: item.page_source,
        hash: hash,
        metadata: metadataString
      });
    }

    if (rows.length > 0) {
      await this.table.add(rows);
    }

    console.log(`[Knowledge] Added ${source} + ${chunksWithSource.length} chunks`);
  }

  async getAllIndexedSources(): Promise<IndexedSource[]> {
    const allEntries = await this.table
      .query()
      .select(["source", "hash", "metadata"])
      .toArray();

    const grouped = new Map<string, IndexedSource>();

    for (const entry of allEntries) {
      if (entry.source === "init") continue;

      if (!grouped.has(entry.source)) {
        grouped.set(entry.source, {
          source: entry.source,
          hash: entry.hash,
          metadata: typeof entry.metadata === "string"
            ? JSON.parse(entry.metadata)
            : entry.metadata,
          chunksCount: 0
        });
      }

      grouped.get(entry.source)!.chunksCount++;
    }

    return Array.from(grouped.values());
  }

  async search(query: string, node: ComputeNode, chunkLimit = 10): Promise<DocumentRow[]> {
    const queryVector = await this.embed(query, node);

    const vectorChunks = await this.table
      .search(queryVector)
      .limit(chunkLimit)
      .toArray();

    if (!vectorChunks.length) return [];

    const uniqueSources = Array.from(new Set(vectorChunks.map((c: any) => c.source)));

    const firstChunksPromises = uniqueSources.map(source =>
      this.table.query().where(`source = '${source}'`).limit(1).toArray()
    );
    const firstChunksResults = await Promise.all(firstChunksPromises);
    const firstChunks = firstChunksResults.map(res => res[0]).filter(Boolean);

    const groupedDocs = new Map<string, DocumentRow>();
    const seenChunks = new Set<string>();

    for (const chunk of firstChunks) {
      groupedDocs.set(chunk.source, {
        source: chunk.source,
        hash: chunk.hash,
        metadata: typeof chunk.metadata === "string" ? JSON.parse(chunk.metadata) : chunk.metadata,
        chunks: []
      });

      groupedDocs.get(chunk.source)!.chunks.push({
        text: chunk.text,
        page_source: chunk.page_source,
        distance: 0,
        is_first: true
      } as any);

      seenChunks.add(chunk.text);
    }

    for (const chunk of vectorChunks) {
      if (seenChunks.has(chunk.text)) continue;
      seenChunks.add(chunk.text);

      if (!groupedDocs.has(chunk.source)) {
        groupedDocs.set(chunk.source, {
          source: chunk.source,
          hash: chunk.hash,
          metadata: typeof chunk.metadata === "string" ? JSON.parse(chunk.metadata) : chunk.metadata,
          chunks: []
        });
      }

      groupedDocs.get(chunk.source)!.chunks.push({
        text: chunk.text,
        page_source: chunk.page_source,
        distance: chunk._distance
      });
    }

    return Array.from(groupedDocs.values());
  }
}

export type IndexedSource = {
  source: string;
  hash: string;
  metadata: any;
  chunksCount: number;
};

export type DocumentRow = {
  source: string;
  hash: string;
  metadata: any;
  chunks: ChunkRow[];
};

export type ChunkRow = {
  text: string;
  page_source: string;
  distance: number;
  is_first?: boolean;
};

export type DocumentPage = {
  text: string;
  source: string;
};