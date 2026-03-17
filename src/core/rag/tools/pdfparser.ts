import fs from 'fs';
import axios from 'axios';
import pdf2md from '@opendocsg/pdf2md';
import {cleanMarkdown} from "./markdownUtils";

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

    return pages.map(page => cleanMarkdown(page));
  } catch (err) {
    throw new Error(`PDF parsing failed: ${(err as Error).message}`);
  }
}

