// Rewind TV: builds a static Nuvio / Stremio addon from public-domain
// Internet Archive collections. Output goes to ./public, which GitHub Pages hosts.
// Run: node build.mjs        (Node 18+; no dependencies)

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

const IA = "https://archive.org";
const OUT = process.env.OUT_DIR || "public";
const PAGE = 50;           // items per catalog page
const PAGES = Number(process.env.PAGES || 4);   // pages per channel (4 x 50 = 200 items)
const CONCURRENCY = 6;     // polite to the Archive

// Only items the uploader tagged public domain or Creative Commons.
const LICENSE = "(licenseurl:*publicdomain* OR licenseurl:*creativecommons*)";

export const GENRES = {
  Comedy: "subject:comedy",
  Drama: "subject:drama",
  Western: "(subject:western OR subject:westerns)",
  "Sci-Fi": '(subject:"science fiction" OR subject:sci-fi)',
  Horror: "subject:horror",
  Noir: '(subject:noir OR subject:"film noir")',
  Mystery: "(subject:mystery OR subject:crime OR subject:detective)",
  Kids: "(subject:children OR subject:family OR subject:kids)",
  Music: "(subject:musical OR subject:music)",
};

export const CHANNELS = [
  { id: "rwtv_tv", name: "Rewind: Classic TV", q: "collection:classic_tv" },
  { id: "rwtv_cartoons", name: "Rewind: Cartoons", q: "(collection:classic_cartoons OR collection:animationandcartoons)" },
  { id: "rwtv_movies", name: "Rewind: Movies", q: "collection:feature_films" },
  {
    id: "rwtv_ads",
    name: "Rewind: Vintage Commercials",
    q: "collection:prelinger AND (subject:advertising OR subject:commercials OR subject:commercial OR title:commercial*)",
  },
  { id: "rwtv_shorts", name: "Rewind: Shorts & Newsreels", q: "(collection:prelinger OR collection:newsandpublicaffairs)" },
];

export const MANIFEST = {
  id: "community.rewindtv",
  version: "1.0.0",
  name: "Rewind TV",
  description:
    "Old-school TV night: classic TV, cartoons, movies and vintage commercials. Public-domain and Creative Commons items from the Internet Archive only. Refreshed weekly.",
  logo: `${IA}/services/img/classic_tv`,
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["rwtv-"],
  catalogs: CHANNELS.map((c) => ({
    type: "movie",
    id: c.id,
    name: c.name,
    extra: [
      { name: "genre", isRequired: false, options: Object.keys(GENRES) },
      { name: "skip", isRequired: false },
    ],
  })),
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ---------- helpers ----------

const first = (v) => (Array.isArray(v) ? v[0] : v);

export function cleanText(s, max = 600) {
  if (!s) return undefined;
  const txt = String(first(s))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!txt) return undefined;
  return txt.length > max ? txt.slice(0, max - 1) + "…" : txt;
}

function yearOf(o) {
  const m = String(first(o.year) || first(o.date) || "").match(/\d{4}/);
  return m ? m[0] : undefined;
}

const poster = (id) => `${IA}/services/img/${encodeURIComponent(id)}`;
// Archive identifiers only use [A-Za-z0-9._-], so they are safe as file names.
const safeId = (id) => /^[A-Za-z0-9._-]+$/.test(id);
const toId = (identifier) => `rwtv-${identifier}`;
const isAllowed = (md) => /publicdomain|creativecommons/i.test(String(first(md.licenseurl) || ""));

async function writeJson(path, data) {
  const full = join(OUT, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(data));
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx], idx);
      }
    })
  );
  return results;
}

export function makeFetcher(fetchImpl = fetch) {
  return async function iaJson(url, tries = 3) {
    for (let t = 1; ; t++) {
      try {
        const res = await fetchImpl(url, { headers: { "User-Agent": "RewindTV-Addon/1.0 (static build)" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        if (t >= tries) throw new Error(`${url}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 1500 * t));
      }
    }
  };
}

// ---------- build steps ----------

export async function search(iaJson, q, page) {
  const p = new URLSearchParams();
  p.set("q", `${q} AND mediatype:movies AND ${LICENSE}`);
  for (const f of ["identifier", "title", "year", "date", "description"]) p.append("fl[]", f);
  p.append("sort[]", "downloads desc");
  p.set("rows", String(PAGE));
  p.set("page", String(page));
  p.set("output", "json");
  const data = await iaJson(`${IA}/advancedsearch.php?${p}`);
  return ((data.response && data.response.docs) || []).filter((d) => d.identifier && safeId(d.identifier));
}

export function videoFiles(files) {
  const playable = files.filter(
    (f) => /mpeg4|h\.264|mp4/i.test(f.format || "") || /\.(mp4|m4v)$/i.test(f.name || "")
  );
  // Group derivatives of the same original so each video appears once, best quality wins.
  const groups = new Map();
  for (const f of playable) {
    const key = String(f.original || f.name)
      .replace(/(_512kb|\.ia)?\.(mp4|m4v)$/i, "")
      .replace(/\.[^./]+$/, "");
    const cur = groups.get(key);
    if (!cur || Number(f.height || 0) > Number(cur.height || 0)) groups.set(key, f);
  }
  return [...groups.values()];
}

export function buildItem(identifier, item) {
  const md = item.metadata || {};
  if (!item.metadata || !isAllowed(md)) return null;
  const files = videoFiles(item.files || []);
  if (!files.length) return null;

  const id = toId(identifier);
  const title = cleanText(md.title, 160) || identifier;
  const multi = files.length > 1;
  const genres = []
    .concat(md.subject || [])
    .flatMap((s) => String(s).split(/[;,]/))
    .map((s) => s.trim())
    .filter((s) => s && s.length < 30)
    .slice(0, 5);

  const meta = {
    id,
    type: "movie",
    name: title,
    poster: poster(identifier),
    posterShape: "landscape",
    background: poster(identifier),
    description: cleanText(md.description, 1500),
    releaseInfo: yearOf(md),
    runtime: cleanText(md.runtime, 40),
    genres,
    website: `${IA}/details/${identifier}`,
  };

  const streams = files.slice(0, 40).map((f) => ({
    name: `Rewind TV\n${f.height ? f.height + "p" : "SD"}`,
    title: multi ? cleanText(f.title, 80) || f.name.replace(/\.[^.]+$/, "").replace(/_/g, " ") : title,
    url: `${IA}/download/${identifier}/${f.name.split("/").map(encodeURIComponent).join("/")}`,
    behaviorHints: { bingeGroup: `rwtv-${identifier}` },
  }));

  return { meta, streams };
}

const preview = (meta) => ({
  id: meta.id,
  type: "movie",
  name: meta.name,
  poster: meta.poster,
  posterShape: "landscape",
  releaseInfo: meta.releaseInfo,
  description: meta.description && meta.description.slice(0, 280),
});

export async function build({ fetchImpl = fetch, log = console.log } = {}) {
  const iaJson = makeFetcher(fetchImpl);
  await rm(OUT, { recursive: true, force: true });

  // 1. Collect catalog lists: each channel's top pages, plus one page per genre.
  const lists = []; // { path, identifiers }
  for (const ch of CHANNELS) {
    for (let page = 1; page <= PAGES; page++) {
      const docs = await search(iaJson, ch.q, page).catch((e) => (log(`! ${e.message}`), []));
      const skip = (page - 1) * PAGE;
      lists.push({
        path: skip ? `catalog/movie/${ch.id}/skip=${skip}.json` : `catalog/movie/${ch.id}.json`,
        identifiers: docs.map((d) => d.identifier),
      });
      if (docs.length < PAGE) break;
    }
    for (const [g, gq] of Object.entries(GENRES)) {
      const docs = await search(iaJson, `${ch.q} AND ${gq}`, 1).catch((e) => (log(`! ${e.message}`), []));
      lists.push({ path: `catalog/movie/${ch.id}/genre=${g}.json`, identifiers: docs.map((d) => d.identifier) });
    }
    log(`✓ ${ch.name}`);
  }

  // 2. Fetch full details once per unique item; drop anything without a playable file or license.
  const unique = [...new Set(lists.flatMap((l) => l.identifiers))];
  log(`Fetching details for ${unique.length} items…`);
  const built = new Map();
  let done = 0;
  await pool(unique, CONCURRENCY, async (identifier) => {
    try {
      const item = await iaJson(`${IA}/metadata/${identifier}`);
      const b = buildItem(identifier, item);
      if (b) built.set(identifier, b);
    } catch (e) {
      log(`! ${e.message}`);
    }
    if (++done % 200 === 0) log(`  ${done}/${unique.length}`);
  });

  // 3. Write everything.
  await writeJson("manifest.json", MANIFEST);
  for (const l of lists) {
    const metas = l.identifiers.filter((i) => built.has(i)).map((i) => preview(built.get(i).meta));
    await writeJson(l.path, { metas });
  }
  for (const [, b] of built) {
    await writeJson(`meta/movie/${b.meta.id}.json`, { meta: b.meta });
    await writeJson(`stream/movie/${b.meta.id}.json`, { streams: b.streams });
  }
  await writeFile(join(OUT, ".nojekyll"), "");
  await writeFile(join(OUT, "404.html"), "Not found");
  await writeFile(join(OUT, "index.html"), landingPage(built.size));

  log(`Done: ${built.size} playable items, ${lists.length} catalog pages.`);
  return { items: built.size, lists: lists.length };
}

function landingPage(count) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rewind TV addon</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;background:#14121a;color:#eee;line-height:1.5}
code{display:block;background:#2a2633;padding:12px;border-radius:8px;word-break:break-all;margin:12px 0}</style></head><body>
<h1>📺 Rewind TV</h1><p>${count} classic TV episodes, cartoons, movies and vintage commercials from the Internet Archive. Public domain and Creative Commons only. Updated weekly.</p>
<p><b>Add to Nuvio:</b> Settings → Addons → Add Addon, then paste:</p><code id="u"></code>
<script>document.getElementById("u").textContent=location.href.replace(/\\/(index\\.html)?$/,"")+"/manifest.json"</script>
</body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
