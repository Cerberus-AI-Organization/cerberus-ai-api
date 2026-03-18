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
): AsyncGenerator<CrawlResult> {
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: maxDepth }];

  while (queue.length > 0) {
    const { url, depth } = queue.shift()!;

    if (visited.has(url) || depth < 0) continue;
    visited.add(url);

    try {
      console.log(`[Crawler] ${url} (Remaining depth: ${depth})`);
      const res = await fetch(url);
      if (!res.ok) continue;

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("application/pdf") || url.endsWith(".pdf")) {
        const pages = await parsePDFFromUrl(url);
        for (const page of pages) yield { url, text: page };
        continue;
      }

      const html = await res.text();
      const $ = cheerio.load(html);

      const main = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
      const cleanHtml = main.clone();
      cleanHtml.find("script, style, nav, footer, header, aside, noscript, svg, img, form, button").remove();

      let markdown = turndown.turndown(cleanHtml.html() || "");
      markdown = cleanMarkdown(markdown);

      yield { url, text: markdown };  // ← yield, pak zahodíme HTML z paměti

      if (depth === 0) continue;

      const baseUrl = new URL(url);
      let count = 0;

      $("a[href]").each((_, el) => {
        if (count >= 20) return;
        const href = $(el).attr("href");
        if (!href) return;
        try {
          const abs = new URL(href, url);
          abs.hash = "";
          const absStr = abs.toString();
          if (
            abs.hostname === baseUrl.hostname &&
            abs.protocol.startsWith("http") &&
            !visited.has(absStr) &&
            !shouldSkipUrl(absStr)
          ) {
            queue.push({ url: absStr, depth: depth - 1 });
            count++;
          }
        } catch {}
      });

    } catch (err) {
      console.error(`[Crawler] Failed to crawl ${url}`, err);
    }
  }
}

const SKIP_URL_PATTERNS = [
  // Auth & account
  /\/(login|logout|signin|signup|register|auth|oauth|password|reset|verify|confirm)(\/|$|\?)/i,
  /\/(account|profile|settings|preferences|dashboard)(\/|$|\?)/i,

  // Legal & boilerplate
  /\/(privacy|terms|tos|legal|cookie|gdpr|disclaimer|license)(\/|$|\?)/i,

  // Commerce & fundraising
  /\/(cart|checkout|order|payment|billing|invoice|subscription|donate|store|shop)(\/|$|\?)/i,

  // Media & assets
  /\.(jpg|jpeg|png|gif|webp|svg|ico|mp4|mp3|wav|zip|tar|gz|exe|dmg)(\?|$)/i,

  // Utility / nav-only pages
  /\/(search|tag|tags|category|categories|archive|archives|rss|feed|sitemap|404|500)(\/|\.|$|\?)/i,
  /\/(print|embed|share|redirect|invite|contact-to-webmaster)(\/|$|\?)/i,

  // Tracking & UTM
  /[?&](utm_|ref=|source=|campaign=|fbclid|gclid|reponame=)/i,

  // CDN / proxy / infrastructure pages (nvd cdn-cgi, Cloudflare, etc.)
  /\/cdn-cgi\//i,

  // Interactive tools with no static text content
  /\/(calculator|calc|widget|tool)(\/|$|\?)/i,
  /\/(v[2-9]-calculator|v\d+\.\d+-calculator)(\/|$|\?)/i,

  // API key request forms (form-only pages)
  /\/request-an-api-key(\/|$|\?)/i,

  // Statistics pages — highly dynamic, change every sync
  /\/statistics(\/|$|\?)/i,

  // Slack / community invite links
  /slack\.com\/(invite|join)/i,

  // Locales that duplicate content
  /\/(zh|ja|ko|ar|he|fa|ru|uk|pl|cs|sk|ro|bg|hr|sr)(\/|$)/i,
];

function shouldSkipUrl(url: string): boolean {
  return SKIP_URL_PATTERNS.some((pattern) => pattern.test(url));
}