export type DocumentPage = {
  text: string;
  source: string;
};

export type DocumentChunk = {
  text: string;
  source: string;
  page_source: string;
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
  score: number;
};

export type IndexedSource = {
  source: string;
  hash: string;
  metadata: any;
  chunksCount: number;
  chunks: DocumentChunk[];
};