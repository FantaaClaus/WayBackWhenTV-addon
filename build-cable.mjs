// Rewind Cable: a cable-style lineup of free, licensed 70s–2000s channels
// (Pluto TV, Samsung TV Plus, Xumo, Roku, Tubi, Plex) for Nuvio.
// Outputs into public/cable/:
//   manifest.json + catalog/meta/stream files  -> Nuvio / Stremio addon
//   lineup.m3u + guide.xml(.gz)                 -> Live TV / IPTV apps with a channel guide
// Run: node build-cable.mjs   (Node 18+, no dependencies)

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const OUT = join(process.env.OUT_DIR || "public", "cable");
const BASE_URL = (process.env.PAGES_URL || "https://fantaaclaus.github.io/WayBackWhenTV-addon").replace(/\/$/, "");
const TZ = process.env.GUIDE_TZ || "America/Boise";
const RAW = "https://raw.githubusercontent.com";

// Free, ad-supported services, in order of preference.
export const SOURCES = [
  { key: "pluto", label: "Pluto TV", m3u: `${RAW}/iptv-org/iptv/master/streams/us_pluto.m3u`, epg: `${RAW}/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz` },
  { key: "samsung", label: "Samsung TV Plus", m3u: `${RAW}/iptv-org/iptv/master/streams/us_samsung.m3u`, epg: `${RAW}/matthuisman/i.mjh.nz/master/SamsungTVPlus/us.xml.gz` },
  { key: "xumo", label: "Xumo", m3u: `${RAW}/iptv-org/iptv/master/streams/us_xumo.m3u` },
  { key: "roku", label: "Roku Channel", m3u: `${RAW}/iptv-org/iptv/master/streams/us_roku.m3u` },
  { key: "tubi", label: "Tubi", m3u: `${RAW}/iptv-org/iptv/master/streams/us_tubi.m3u` },
  { key: "plex", label: "Plex", m3u: `${RAW}/iptv-org/iptv/master/streams/us_plex.m3u`, epg: `${RAW}/matthuisman/i.mjh.nz/master/Plex/us.xml.gz` },
];
const LOGOS = `${RAW}/iptv-org/api/gh-pages/logos.json`;

// ---------- parsing ----------

export const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");

export function parseM3U(text, source) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXTINF")) continue;
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l) continue;
      if (l.startsWith("#")) continue; // #EXTVLCOPT etc.
      url = l;
      break;
    }
    if (!/^https?:\/\//.test(url)) continue;
    const rawName = line.slice(line.lastIndexOf(",") + 1).trim();
    const tvgId = (line.match(/tvg-id="([^"]*)"/) || [])[1] || "";
    const res = Number((rawName.match(/\((\d{3,4})p\)/) || [])[1] || 0);
    const tags = (rawName.match(/\[[^\]]+\]/g) || []).map((t) => t.toLowerCase());
    const name = rawName.replace(/\(\d{3,4}p\)/g, "").replace(/\[[^\]]+\]/g, "").trim();
    const plutoId = (url.match(/plu-([a-f0-9]{24})/) || [])[1];
    out.push({
      name,
      key: norm(name),
      url,
      tvgId: tvgId.split("@")[0],
      res,
      geo: tags.some((t) => t.includes("geo")),
      notLive: tags.some((t) => t.includes("not 24/7")),
      source: source.key,
      sourceLabel: source.label,
      epgId: plutoId || null,
    });
  }
  return out;
}

// Lightweight XMLTV reader (the feeds are machine-generated and regular).
const unxml = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
const xml = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function parseXMLTV(text) {
  const names = new Map(); // epg id -> display name
  const icons = new Map(); // epg id -> logo url
  for (const m of text.matchAll(/<channel id="([^"]+)">([\s\S]*?)<\/channel>/g)) {
    const dn = (m[2].match(/<display-name[^>]*>([\s\S]*?)<\/display-name>/) || [])[1];
    const icon = (m[2].match(/<icon src="([^"]+)"/) || [])[1];
    names.set(unxml(m[1]), unxml(dn));
    if (icon) icons.set(unxml(m[1]), unxml(icon));
  }
  const progs = new Map(); // epg id -> [{start, stop, title, sub, desc}]
  for (const m of text.matchAll(/<programme([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const attrs = m[1];
    const ch = unxml((attrs.match(/channel="([^"]+)"/) || [])[1]);
    const start = (attrs.match(/start="([^"]+)"/) || [])[1];
    const stop = (attrs.match(/stop="([^"]+)"/) || [])[1];
    if (!ch || !start || !stop) continue;
    const body = m[2];
    const get = (tag) => unxml((body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]);
    if (!progs.has(ch)) progs.set(ch, []);
    progs.get(ch).push({ start, stop, title: get("title"), sub: get("sub-title"), desc: get("desc") });
  }
  return { names, progs, icons };
}

// "20261107160000 +0000" -> Date
export function xmltvDate(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!m) return new Date(NaN);
  const [, y, mo, d, h, mi, se, tz = "+0000"] = m;
  const sign = tz[0] === "-" ? -1 : 1;
  const off = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - off * 60000);
}

// ---------- build ----------

async function getText(fetchImpl, url, gz = false) {
  const res = await fetchImpl(url, { headers: { "User-Agent": "RewindCable/1.0" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!gz) return res.text();
  const buf = Buffer.from(await res.arrayBuffer());
  return gunzipSync(buf).toString("utf8");
}

async function writeOut(path, data) {
  const full = join(OUT, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

const slug = (s) => norm(s) || "x";

export async function buildCable({ fetchImpl = fetch, log = console.log, now = new Date(), lineupPath = "lineup.json" } = {}) {
  const lineup = JSON.parse(await readFile(lineupPath, "utf8"));

  // 1. Pull every source's channel list.
  const all = [];
  for (const s of SOURCES) {
    try {
      const entries = parseM3U(await getText(fetchImpl, s.m3u), s);
      all.push(...entries);
      log(`✓ ${s.label}: ${entries.length} channels`);
    } catch (e) {
      log(`! ${s.label} listing failed: ${e.message}`);
    }
  }
  const byKey = new Map();
  for (const e of all) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }
  const srcRank = Object.fromEntries(SOURCES.map((s, i) => [s.key, i]));

  // 2. Guide data.
  const guides = [];
  for (const s of SOURCES.filter((s) => s.epg)) {
    try {
      guides.push({ source: s.key, ...parseXMLTV(await getText(fetchImpl, s.epg, true)) });
      log(`✓ ${s.label} guide`);
    } catch (e) {
      log(`! ${s.label} guide failed: ${e.message}`);
    }
  }

  // 3. Logos.
  let logos = [];
  try {
    logos = JSON.parse(await getText(fetchImpl, LOGOS));
  } catch (e) {
    log(`! logos failed: ${e.message}`);
  }
  const logoFor = (ids) => {
    for (const id of ids) {
      if (!id) continue;
      const cands = logos.filter((l) => l.channel === id && /png|jpe?g/i.test(l.format || ""));
      cands.sort((a, b) => (b.width || 0) - (a.width || 0));
      if (cands[0]) return cands[0].url;
    }
    return undefined;
  };

  // 4. Resolve each lineup channel.
  const horizon = new Date(now.getTime() + 24 * 3600 * 1000);
  const channels = [];
  for (const c of lineup.channels) {
    const found = c.match.flatMap((n) => byKey.get(norm(n)) || []);
    const seen = new Set();
    const streams = found
      .filter((e) => (seen.has(e.url) ? false : seen.add(e.url)))
      .sort((a, b) => a.geo - b.geo || a.notLive - b.notLive || srcRank[a.source] - srcRank[b.source] || b.res - a.res);
    if (!streams.length) {
      log(`- Ch ${c.ch} ${c.name}: not found in any free service right now, skipping`);
      continue;
    }

    // Guide: exact Pluto id first, then a display-name match in any guide.
    let schedule = [];
    let guideIcon;
    for (const g of guides) {
      let ids = streams.filter((s) => s.source === g.source && s.epgId).map((s) => s.epgId);
      if (!ids.some((id) => g.progs.has(id))) {
        const want = new Set(c.match.map(norm));
        ids = [...g.names].filter(([, dn]) => want.has(norm(dn))).map(([id]) => id);
      }
      const hit = ids.find((id) => g.progs.has(id));
      if (hit) {
        guideIcon = g.icons.get(hit);
        schedule = g.progs
          .get(hit)
          .map((p) => ({ ...p, s: xmltvDate(p.start), e: xmltvDate(p.stop) }))
          .filter((p) => p.e > now && p.s < horizon)
          .sort((a, b) => a.s - b.s);
        break;
      }
    }

    channels.push({
      ...c,
      id: `rwcable-${c.ch}`,
      logo: logoFor(streams.map((s) => s.tvgId)) || guideIcon,
      streams: streams.slice(0, 4),
      schedule,
    });
  }
  channels.sort((a, b) => a.ch - b.ch);
  log(`Lineup: ${channels.length} of ${lineup.channels.length} channels found`);

  // 5. Addon files.
  const time = (d) => d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;

  const describe = (c) => {
    const head = `Channel ${c.ch} · ${c.group} · ${c.eras.join(", ")}`;
    if (!c.schedule.length) return `${head}\n\nLive 24/7 on ${c.streams[0].sourceLabel}.`;
    const rows = c.schedule
      .slice(0, 14)
      .map((p) => `${time(p.s)}  ${p.title}${p.sub && p.sub !== p.title ? ` – ${p.sub}` : ""}`);
    return `${head}\n\nSchedule (${tzName}):\n${rows.join("\n")}`;
  };
  const nowOn = (c) => {
    const p = c.schedule.find((p) => p.s <= now && p.e > now) || c.schedule[0];
    return p ? p.title : undefined;
  };

  const display = (c) => `${c.ch} · ${c.name}`;
  const preview = (c) => ({
    id: c.id,
    type: "tv",
    name: display(c),
    poster: c.logo,
    posterShape: "landscape",
    logo: c.logo,
    description: nowOn(c) ? `On around build time: ${nowOn(c)}` : c.group,
    genres: [c.group, ...c.eras],
  });

  const catalogs = [{ id: "rwcable_all", name: "📺 Rewind Cable: Full Lineup", pick: () => true }]
    .concat(lineup.eras.map((era) => ({ id: `rwcable_${slug(era)}`, name: `Rewind Cable: ${era}`, pick: (c) => c.eras.includes(era) })))
    .concat(lineup.groups.map((g) => ({ id: `rwcable_${slug(g)}`, name: `Rewind Cable: ${g}`, pick: (c) => c.group === g })));

  const manifest = {
    id: "community.rewindcable",
    version: "1.0.0",
    name: "Rewind Cable",
    description:
      "A cable-style channel lineup of 70s–2000s TV: real shows on free, licensed 24/7 channels with commercial breaks (Pluto TV, Samsung TV Plus, Xumo and more). Schedules refresh every few hours.",
    logo: channels.find((c) => c.logo)?.logo,
    resources: ["catalog", "meta", "stream"],
    types: ["tv"],
    idPrefixes: ["rwcable-"],
    catalogs: catalogs
      .filter((cat) => channels.some(cat.pick))
      .map((cat) => ({ type: "tv", id: cat.id, name: cat.name })),
    behaviorHints: { configurable: false, configurationRequired: false },
  };
  await writeOut("manifest.json", manifest);
  for (const cat of catalogs) {
    await writeOut(`catalog/tv/${cat.id}.json`, { metas: channels.filter(cat.pick).map(preview) });
  }
  for (const c of channels) {
    await writeOut(`meta/tv/${c.id}.json`, {
      meta: { ...preview(c), background: c.logo, description: describe(c), releaseInfo: c.eras.join(" · ") },
    });
    await writeOut(`stream/tv/${c.id}.json`, {
      streams: c.streams.map((s, i) => ({
        name: `Ch ${c.ch}\n${i === 0 ? "LIVE" : "Backup"}`,
        title: `${c.name} · ${s.sourceLabel}${s.res ? ` · ${s.res}p` : ""}`,
        url: s.url,
        behaviorHints: { notWebReady: false },
      })),
    });
  }

  // 6. Cable box files: M3U lineup + XMLTV guide.
  const guideUrl = `${BASE_URL}/cable/guide.xml.gz`;
  const m3u = [`#EXTM3U x-tvg-url="${guideUrl}" url-tvg="${guideUrl}"`];
  for (const c of channels) {
    m3u.push(
      `#EXTINF:-1 tvg-id="${c.id}" tvg-chno="${c.ch}" channel-number="${c.ch}" tvg-name="${xml(c.name)}"${c.logo ? ` tvg-logo="${c.logo}"` : ""} group-title="${xml(c.group)}",${c.name}`,
      c.streams[0].url
    );
  }
  await writeOut("lineup.m3u", m3u.join("\n") + "\n");

  const fmt = (d) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
  const gx = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Rewind Cable">'];
  for (const c of channels) {
    gx.push(`  <channel id="${c.id}"><display-name>${xml(c.name)}</display-name><display-name>${c.ch}</display-name>${c.logo ? `<icon src="${xml(c.logo)}"/>` : ""}</channel>`);
  }
  for (const c of channels) {
    for (const p of c.schedule) {
      gx.push(
        `  <programme channel="${c.id}" start="${fmt(p.s)}" stop="${fmt(p.e)}"><title>${xml(p.title)}</title>${p.sub ? `<sub-title>${xml(p.sub)}</sub-title>` : ""}${p.desc ? `<desc>${xml(p.desc)}</desc>` : ""}</programme>`
      );
    }
  }
  gx.push("</tv>");
  const guideXml = gx.join("\n");
  await writeOut("guide.xml", guideXml);
  await writeOut("guide.xml.gz", gzipSync(guideXml));

  await writeOut("index.html", page(channels, guides.length > 0));
  const withGuide = channels.filter((c) => c.schedule.length).length;
  log(`Done: ${channels.length} channels, ${withGuide} with guide data.`);
  return { channels: channels.length, withGuide };
}

function page(channels, hasGuide) {
  const rows = channels
    .map((c) => `<tr><td class="n">${c.ch}</td><td>${xml(c.name)}</td><td>${xml(c.group)}</td><td>${c.eras.join(", ")}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rewind Cable</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#101014;color:#eee;line-height:1.5}
code{display:block;background:#24242c;padding:10px 12px;border-radius:8px;word-break:break-all;margin:8px 0 16px}
table{border-collapse:collapse;width:100%;font-size:14px}td{padding:6px 8px;border-bottom:1px solid #2a2a33}.n{color:#ffb86b;font-weight:700;width:40px}</style></head><body>
<h1>📺 Rewind Cable</h1><p>${channels.length} channels of 70s–2000s TV from free, licensed streaming services, with real commercial breaks.</p>
<p><b>Nuvio addon</b> (Settings → Addons → Add Addon):</p><code class="u" data-p="manifest.json"></code>
<p><b>Live TV / IPTV playlist</b> (channel numbers + guide):</p><code class="u" data-p="lineup.m3u"></code>
${hasGuide ? '<p><b>Guide (EPG) URL</b>, if your app asks for it separately:</p><code class="u" data-p="guide.xml.gz"></code>' : ""}
<h2>Lineup</h2><table>${rows}</table>
<script>const b=location.href.replace(/[^/]*$/,"");document.querySelectorAll(".u").forEach(e=>e.textContent=b+e.dataset.p)</script>
</body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildCable().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
