import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

export function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);
  const main = $('main').length ? $('main') : $('article').length ? $('article') : $('body');
  const clean = main.clone();
  clean.find('script, style, nav, footer, header, aside, noscript, svg, img, form, button').remove();
  const md = turndown.turndown(clean.html() || '');
  return cleanMarkdown(md);
}

export function cleanMarkdown(md: string): string {
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