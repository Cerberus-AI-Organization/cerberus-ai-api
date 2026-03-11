import { DocumentChunk, DocumentPage } from "./types";

const MIN_CHUNK_LENGTH = 500;
const MAX_CHUNK_LENGTH = 2000;
const OVERLAP = 200;

export class DocumentChunker {
  createChunks(pages: DocumentPage[], source: string): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let currentText = "";
    let currentSource = "";
    let headingStack: string[] = [];

    const getStructure = () =>
      headingStack.length > 0 ? headingStack.join(" / ") : "";

    for (const page of pages) {
      const blocks = page.text.split(/(?=^#{1,6} )/m);

      for (const block of blocks) {
        const headingMatch = block.trimStart().match(/^(#{1,6}) (.+)/);

        if (headingMatch) {
          if (currentText.trim().length > MIN_CHUNK_LENGTH) {
            this.pushWithMaxLimit(chunks, currentText.trim(), source, currentSource, getStructure());
            currentText = "";
          }

          const level = headingMatch[1].length;
          const headingText = `${headingMatch[1]} ${headingMatch[2].split("\n")[0].trim()}`;

          headingStack = headingStack.filter(
            (h) => (h.match(/^(#+)/)?.[1].length ?? 0) < level
          );
          headingStack.push(headingText);

          currentSource = page.source;
          currentText = block;
        } else {
          if (currentText.trim().length === 0) {
            currentSource = page.source;
          }
          const needsSeparator = currentText.length > 0 && !/\s$/.test(currentText) && !/^\s/.test(block);
          currentText += needsSeparator ? " " + block : block;
        }
      }
    }

    if (currentText.trim().length > 0) {
      this.pushWithMaxLimit(chunks, currentText.trim(), source, currentSource, getStructure());
    }

    return chunks;
  }

  private pushWithMaxLimit(
    chunks: DocumentChunk[],
    text: string,
    source: string,
    page_source: string,
    structure: string
  ) {
    const format = (t: string) => `SOURCE: ${source}(${page_source})\nSTRUCTURE: ${structure}\nTEXT: ${t}`;

    if (text.length <= MAX_CHUNK_LENGTH) {
      chunks.push({ text: format(text), source, page_source });
      return;
    }

    let remaining = text;

    while (remaining.length > MAX_CHUNK_LENGTH) {
      let splitAt = remaining.lastIndexOf("\n\n", MAX_CHUNK_LENGTH);

      if (splitAt === -1 || splitAt < MAX_CHUNK_LENGTH / 2) {
        splitAt = remaining.lastIndexOf(". ", MAX_CHUNK_LENGTH);
      }
      if (splitAt === -1 || splitAt < MAX_CHUNK_LENGTH / 2) {
        splitAt = remaining.lastIndexOf(" ", MAX_CHUNK_LENGTH);
      }
      if (splitAt === -1) {
        splitAt = MAX_CHUNK_LENGTH;
      }

      const chunk = remaining.substring(0, splitAt + 1).trim();
      if (chunk.length > 0) chunks.push({ text: format(chunk), source, page_source });

      remaining = remaining.substring(splitAt + 1 - OVERLAP).trimStart();
    }

    if (remaining.length > 0) {
      chunks.push({ text: format(remaining.trimEnd()), source, page_source });
    }
  }
}