import fs from 'fs';
import axios from 'axios';
import pdf2md from '@opendocsg/pdf2md';

export async function parsePDF(filePath: string): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`PDF file not found: ${filePath}`);
  }

  const pdfBuffer = fs.readFileSync(filePath);
  return processPdfBuffer(pdfBuffer);
}

export async function parsePDFFromUrl(url: string): Promise<string[]> {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'Accept': 'application/pdf',
      }
    });

    const pdfBuffer = Buffer.from(response.data);
    return processPdfBuffer(pdfBuffer);
  } catch (err) {
    throw new Error(`Failed to fetch PDF from URL: ${(err as Error).message}`);
  }
}

async function processPdfBuffer(buffer: Buffer): Promise<string[]> {
  try {
    const markdown = await pdf2md(buffer);
    const pages = markdown.split("\n\n\n")

    return pages.map(page => cleanPdfMarkdown(page));
  } catch (err) {
    throw new Error(`PDF parsing failed: ${(err as Error).message}`);
  }
}

function cleanPdfMarkdown(md: string): string {
  let out = md;
  out = fixBrokenLines(out);
  out = collapseEmptyLines(out);
  out = mergeSectionTitle(out);
  out = normalizeHeadings(out);
  return out.trim();
}

function fixBrokenLines(text: string): string {
  return text.replace(/([a-zá-ž0-9,;])\n([a-zá-ž(])/gi, '$1 $2');
}

function collapseEmptyLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

function normalizeHeadings(text: string): string {
  return text
    .replace(/^#####\s+/gm, '#### ')
    .replace(/^######\s+/gm, '##### ');
}

function mergeSectionTitle(text: string): string {
  return text.replace(
    /(###\s+§\s*\d+)\s*\n\s*(###\s+.+)/g,
    (_, p1, p2) => {
      const title = p2.replace(/^###\s+/, '');
      return `${p1} – ${title}`;
    }
  );
}