#!/usr/bin/env node
// Render a "Previously on AI" items.json into an RSS 2.0 feed.
// Usage: node rss.js <items.json> <out-feed.xml>
// Kept dependency-free on purpose — same philosophy as validate.js.
const fs = require("fs");

const SITE = "https://sungjukim.com/lab";
const FEED_URL = "https://sungjukim.com/data/feed.xml";

const [items, out] = process.argv.slice(2);
if (!items || !out) { console.error("usage: rss.js <items.json> <out-feed.xml>"); process.exit(2); }

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const d = JSON.parse(fs.readFileSync(items, "utf8"));
const rfc822 = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? new Date().toUTCString() : new Date(t).toUTCString();
};

const entries = (d.items || []).map((it) => `    <item>
      <title>${esc(it.title_en)}</title>
      <link>${esc(it.source_url)}</link>
      <guid isPermaLink="false">${esc(it.id)}</guid>
      <pubDate>${rfc822(it.published_at)}</pubDate>
      <category>${esc(it.category)}</category>
      <description>${esc(
        `${it.summary_en}\n\nWhy it matters: ${it.why_en}\n\n— KO —\n${it.summary_ko}\n\n왜 중요한가: ${it.why_ko}`
      )}</description>
    </item>`).join("\n");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Previously on AI</title>
    <link>${SITE}</link>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>
    <description>Daily AI ecosystem changelog — collected, deduplicated, and summarized (EN/KO) by a scheduled agent.</description>
    <language>en</language>
    <lastBuildDate>${rfc822(d.generated_at)}</lastBuildDate>
    <ttl>1440</ttl>
${entries}
  </channel>
</rss>
`;

fs.writeFileSync(out + ".tmp", xml);
fs.renameSync(out + ".tmp", out);
console.log(`[rss] ${d.items.length} items → ${out}`);
