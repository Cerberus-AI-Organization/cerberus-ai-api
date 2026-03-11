import fetch from "node-fetch";
import * as cheerio from "cheerio";
import {parsePDFFromUrl} from "./pdfparser";

interface CrawlResult {
  url: string;
  text: string;
}

export async function crawlWeb(
  startUrl: string,
  maxDepth: number = 3,
  visited = new Set<string>()
): Promise<CrawlResult[]> {
  const results: CrawlResult[] = [];

  if (maxDepth < 0 || visited.has(startUrl)) return results;
  visited.add(startUrl);

  try {
    // console.log(`[Crawling] ${startUrl} (Remaining depth: ${maxDepth})`);

    const res = await fetch(startUrl);
    if (!res.ok) return results;

    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("application/pdf") || startUrl.toLowerCase().endsWith(".pdf")) {
      const pages = await parsePDFFromUrl(startUrl);
      results.push({url: startUrl, text: pages.join("\n\n\n")});
      return results;
    } else {

      const html = await res.text();
      const $ = cheerio.load(html);

      const cleanHtml = $("body").clone();
      cleanHtml.find("script, style, nav, footer, header").remove();
      const text = cleanHtml.text().replace(/\s+/g, " ").trim();

      results.push({url: startUrl, text});

      if (maxDepth === 0) return results;

      const baseUrl = new URL(startUrl);
      const links: string[] = [];

      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        try {
          const absoluteUrl = new URL(href, startUrl);
          if (absoluteUrl.hostname === baseUrl.hostname && absoluteUrl.protocol.startsWith('http')) {
            absoluteUrl.hash = "";
            links.push(absoluteUrl.toString());
          }
        } catch (e) {
          // Invalid URL, ignore it
        }
      });

      const uniqueLinks = [...new Set(links)];
      for (const link of uniqueLinks) {
        const subResults = await crawlWeb(link, maxDepth - 1, visited);
        results.push(...subResults);
      }
    }
  } catch (error) {
    console.error(`Failed to crawl url ${startUrl}:`, error);
  }

  return results;
}