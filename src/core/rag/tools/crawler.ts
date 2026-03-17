import fetch from "node-fetch";
import * as cheerio from "cheerio";
import {parsePDFFromUrl} from "./pdfparser";
import TurndownService from "turndown";
import {cleanMarkdown} from "./markdownUtils";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

interface CrawlResult {
  url: string;
  text: string;
}

export async function* crawlWeb(
  startUrl: string,
  maxDepth: number = 2,
  visited = new Set<string>()
): AsyncGenerator<CrawlResult> {

  if (maxDepth < 0 || visited.has(startUrl)) return;
  visited.add(startUrl);

  try {
    console.log(`[Crawling] ${startUrl} (Remaining depth: ${maxDepth})`);

    const res = await fetch(startUrl);
    if (!res.ok) return;

    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("application/pdf") || startUrl.endsWith(".pdf")) {
      const pages = await parsePDFFromUrl(startUrl);

      for (const page of pages) {
        yield {
          url: startUrl,
          text: page
        };
      }
      return;
    }

    // 🌐 HTML
    const html = await res.text();
    const $ = cheerio.load(html);

    const main = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
    const cleanHtml = main.clone();
    cleanHtml.find(`script, style, nav, footer, header, aside, noscript, svg, img, form, button`).remove();

    const htmlContent = cleanHtml.html() || "";

    let markdown = turndown.turndown(htmlContent);
    markdown = cleanMarkdown(markdown);

    yield { url: startUrl, text: markdown };

    if (maxDepth === 0) return;

    const baseUrl = new URL(startUrl);
    const links = new Set<string>();

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      try {
        const absoluteUrl = new URL(href, startUrl);
        if (
          absoluteUrl.hostname === baseUrl.hostname &&
          absoluteUrl.protocol.startsWith("http")
        ) {
          absoluteUrl.hash = "";
          links.add(absoluteUrl.toString());
        }
      } catch {}
    });

    const MAX_LINKS_PER_PAGE = 20;
    let count = 0;

    for (const link of links) {
      if (count++ > MAX_LINKS_PER_PAGE) break;

      yield* crawlWeb(link, maxDepth - 1, visited);
    }

  } catch (err) {
    console.error(`Failed to crawl ${startUrl}`, err);
  }
}