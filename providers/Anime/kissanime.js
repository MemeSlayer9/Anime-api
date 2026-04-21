import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";
import he from "he";
import { EventEmitter } from "events";

import {
  extractExternalIds,
  mapAnilistMedia,
  fetchAnilistMedia,
  resolveTMDB,
} from '../Anime/meta/graphqltmbd.js';

EventEmitter.defaultMaxListeners = 100;

const app    = express();
const router = express.Router();

app.use(cors());

function requireApiKey(req, res) {
  if (req.query.apiKey !== "fuckyoubitch") {
    res.status(401).json({ error: "Unauthorized: invalid or missing apiKey" });
    return false;
  }
  return true;
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const PROVIDER_RESOLVERS = {
  kissanime: async (media) => {
    const candidates = [
      media.title?.english,
      media.title?.romaji,
      ...(media.synonyms || []),
    ].filter(Boolean);

    const titleSlugs = [...new Set(candidates.map(slugify).filter(s => s.length > 2))];
    console.log(`[resolver] titleSlugs:`, titleSlugs);

    function isMatch(slug) {
      if (!slug) return false;
      const base = slug.replace(/-[0-9a-fA-F]{4,8}$/, '');
      return titleSlugs.some(ts =>
        base === ts ||
        slug === ts ||
        base.startsWith(ts + '-') ||
        ts.startsWith(base)
      );
    }

    async function fetchPage(key, page, size) {
      const { data } = await axios.get('https://kaa.lt/api/anime', {
        params: { [key]: page, limit: size },
        headers: { ...HEADERS, Referer: 'https://kaa.lt/' },
        timeout: 10000,
      });
      return Array.isArray(data)
        ? data
        : (data.result || data.results || data.items || data.data || []);
    }

    for (const link of media.externalLinks || []) {
      const m = (link.url || '').match(/kaa\.lt\/([a-z0-9][a-z0-9-]+-[a-f0-9]{4,8})(?:\/|$)/i);
      if (m) return m[1];
    }

    const searchTerms = [
      media.title?.romaji,
      media.title?.english,
      ...(media.synonyms || []).slice(0, 2),
    ].filter(Boolean);

    const searchUrls = searchTerms.flatMap(term => [
      `https://kaa.lt/?q=${encodeURIComponent(term)}`,
      `https://kaa.lt/search?q=${encodeURIComponent(term)}`,
      `https://kaa.lt/?search=${encodeURIComponent(term)}`,
      `https://kaa.lt/search?keyword=${encodeURIComponent(term)}`,
    ]);

    const htmlSearchResults = await Promise.allSettled(
      searchUrls.map(url =>
        axios.get(url, {
          headers: { ...HEADERS, Referer: 'https://kaa.lt/' },
          timeout: 8000,
        }).then(({ data: html }) => {
          const $s = cheerio.load(html);
          let found = null;
          $s('a[href]').each((_, el) => {
            if (found) return;
            const href = $s(el).attr('href') || '';
            const m = href.match(/^\/([a-z0-9][a-z0-9-]+-[0-9a-f]{4,8})(?:\/|$)/i);
            if (m && isMatch(m[1])) found = m[1];
          });
          return found;
        })
      )
    );
    for (const r of htmlSearchResults) {
      if (r.status === 'fulfilled' && r.value) {
        console.log(`[resolver] Found via HTML search:`, r.value);
        return r.value;
      }
    }

    const directProbes = await Promise.allSettled(
      titleSlugs.slice(0, 4).map(ts =>
        axios.get(`https://kaa.lt/${ts}`, {
          headers: { ...HEADERS, Referer: 'https://kaa.lt/' },
          maxRedirects: 5,
          timeout: 8000,
          validateStatus: s => s < 404,
        }).then(resp => {
          const finalUrl = resp.request?.res?.responseUrl
            || (resp.request?.path ? `https://kaa.lt${resp.request.path}` : '')
            || '';
          const mu = finalUrl.match(/kaa\.lt\/([a-z0-9][a-z0-9-]+?)(?:\/.*)?$/i);
          if (mu && isMatch(mu[1])) return mu[1];

          const $p = cheerio.load(resp.data || '');
          let found = null;
          $p('a[href], link[rel="canonical"]').each((_, el) => {
            if (found) return;
            const href = $p(el).attr('href') || '';
            const m = href.match(/kaa\.lt\/([a-z0-9][a-z0-9-]+-[0-9a-f]{4,8})(?:\/|$)/i)
                   || href.match(/^\/([a-z0-9][a-z0-9-]+-[0-9a-f]{4,8})(?:\/|$)/i);
            if (m && isMatch(m[1])) found = m[1];
          });
          return found;
        })
      )
    );
    for (const r of directProbes) {
      if (r.status === 'fulfilled' && r.value) {
        console.log(`[resolver] Found via redirect probe:`, r.value);
        return r.value;
      }
    }

    const apiProbes = await Promise.allSettled(
      titleSlugs.slice(0, 4).flatMap(ts => [
        `https://kaa.lt/api/show/${ts}`,
        `https://kaa.lt/api/anime/${ts}`,
        `https://kaa.lt/api/shows/${ts}`,
      ].map(url =>
        axios.get(url, {
          headers: { ...HEADERS, Referer: 'https://kaa.lt/' },
          timeout: 5000,
          validateStatus: s => s < 404,
        }).then(({ data }) => data?.slug || data?.id || data?.showSlug || null)
      ))
    );
    for (const r of apiProbes) {
      if (r.status === 'fulfilled' && r.value) {
        console.log(`[resolver] Found via direct API probe:`, r.value);
        return r.value;
      }
    }

    let pageSize   = 30;
    let workingKey = 'page';

    try {
      const items = await fetchPage('page', 1, 100);
      pageSize = items.length || 30;
      for (const r of items) { if (isMatch(r.slug)) return r.slug; }

      const firstSlug = items[0]?.slug;
      for (const key of ['page', 'p']) {
        try {
          const pg2 = await fetchPage(key, 2, pageSize);
          if (pg2[0]?.slug && pg2[0].slug !== firstSlug) {
            workingKey = key;
            for (const r of pg2) { if (isMatch(r.slug)) return r.slug; }
            break;
          }
        } catch {}
      }
    } catch (e) {
      console.log(`[resolver] initial fetch failed:`, e.message);
    }

    let maxPage = 1;
    try {
      const probes      = [50, 100, 150, 200, 300, 400, 600, 800, 1000];
      const probeResults = await Promise.allSettled(
        probes.map(p => fetchPage(workingKey, p, pageSize))
      );
      for (let i = probeResults.length - 1; i >= 0; i--) {
        const r = probeResults[i];
        if (r.status === 'fulfilled' && r.value?.length > 0) {
          maxPage = probes[i];
          break;
        }
      }
      for (const r of probeResults) {
        if (r.status !== 'fulfilled') continue;
        for (const item of r.value) {
          if (isMatch(item.slug)) {
            console.log(`[resolver] Found during maxPage probe:`, item.slug);
            return item.slug;
          }
        }
      }
    } catch {}
    console.log(`[resolver] maxPage: ${maxPage}`);

    const SORT_PARAMS = [
      { sort: 'latest' }, { sort: 'newest' }, { sort: 'recent' },
      { order: 'desc' },  { sortBy: 'createdAt', order: 'desc' },
    ];
    const sortProbes = await Promise.allSettled(
      SORT_PARAMS.flatMap(sortParam =>
        [1, 2, 3].map(p =>
          axios.get('https://kaa.lt/api/anime', {
            params: { [workingKey]: p, limit: pageSize, ...sortParam },
            headers: { ...HEADERS, Referer: 'https://kaa.lt/' },
            timeout: 8000,
          }).then(({ data }) => {
            const items = Array.isArray(data) ? data : (data.result || data.results || data.items || data.data || []);
            return items.find(r => isMatch(r.slug))?.slug || null;
          })
        )
      )
    );
    for (const r of sortProbes) {
      if (r.status === 'fulfilled' && r.value) {
        console.log(`[resolver] Found via sort probe:`, r.value);
        return r.value;
      }
    }

    const tailPages = Array.from(
      { length: Math.min(20, maxPage) },
      (_, i) => maxPage - i
    ).filter(p => p > 1);

    const tailResults = await Promise.allSettled(
      tailPages.map(p => fetchPage(workingKey, p, pageSize))
    );
    for (const r of tailResults) {
      if (r.status !== 'fulfilled') continue;
      const hit = r.value.find(item => isMatch(item.slug));
      if (hit) {
        console.log(`[resolver] Found in tail scan:`, hit.slug);
        return hit.slug;
      }
    }

    const BATCH_SIZE = 50;
    for (let batchStart = 2; batchStart <= maxPage; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, maxPage);
      const pageNums = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

      const results = await Promise.allSettled(
        pageNums.map(p => fetchPage(workingKey, p, pageSize))
      );

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const hit = result.value.find(item => isMatch(item.slug));
        if (hit) {
          console.log(`[resolver] Found via full scan:`, hit.slug);
          return hit.slug;
        }
      }
    }

    const fallbacks = await Promise.allSettled(
      titleSlugs.slice(0, 3).flatMap(ts => [
        `https://kaa.lt/api/show/${ts}`,
        `https://kaa.lt/api/anime/${ts}`,
      ].map(url =>
        axios.get(url, {
          headers: { ...HEADERS, Referer: 'https://kaa.lt/' },
          timeout: 5000,
        }).then(({ data }) => {
          const slug = data.slug || data.id || data.showSlug;
          return (slug && isMatch(slug)) ? slug : null;
        })
      ))
    );
    for (const r of fallbacks) {
      if (r.status === 'fulfilled' && r.value) return r.value;
    }

    console.log(`[resolver] Exhausted all strategies for:`, titleSlugs[0]);
    return null;
  },
};

function decodeUnicode(str) {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
}

function fixUrl(url) {
  if (!url) return url;
  url = url.replace(/^(https?):\/\/\/+/, "$1://");
  if (url.startsWith("//")) url = "https:" + url;
  return url;
}

function isAbsoluteUrl(url) {
  return /^https?:\/\/.+/.test(url);
}

function parseTagAttrs(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

async function resolveAnilistIdFromSlug(slug) {
  try {
    // Strip the hex suffix (e.g. "marriagetoxin-a521" → "marriage toxin")
    const title = slug
      .replace(/-[0-9a-f]{4,8}$/i, "")
      .replace(/-/g, " ")
      .trim();

    const query = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          id
        }
      }
    `;
    const { data } = await axios.post("https://graphql.anilist.co", {
      query,
      variables: { search: title },
    }, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 6000,
    });
    return data?.data?.Media?.id ?? null;
  } catch {
    return null;
  }
}

async function fetchMasterPlaylist(masterUrl, referer, debug) {
  try {
    debug.push(`[M] Fetching master m3u8: ${masterUrl}`);
    const { data: m3u8Text } = await axios.get(masterUrl, {
      headers: {
        ...HEADERS,
        Referer: referer,
        Origin: "https://kaa.lt",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "text",
    });

    debug.push(`[M] Raw m3u8 content:\n${m3u8Text}`);

    const base  = new URL(masterUrl);
    const audio = [];
    const video = [];

    function resolve(token) {
      token = token.trim();
      if (/^https?:\/\//.test(token)) return token;
      if (token.startsWith("//")) return "https:" + token;
      if (token.startsWith("/")) return `${base.protocol}//${base.host}${token}`;
      const dir = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
      return dir + token;
    }

    const lines = m3u8Text.split(/\r?\n|\r/);
    let pendingStreamInf = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseTagAttrs(trimmed);
        if (attrs.URI) {
          audio.push({
            url:      resolve(attrs.URI),
            type:     attrs.TYPE        || "AUDIO",
            name:     attrs.NAME        || "",
            language: attrs.LANGUAGE    || "",
            groupId:  attrs["GROUP-ID"] || "",
            default:  attrs.DEFAULT === "YES",
          });
        }
        pendingStreamInf = null;
        continue;
      }

      if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
        pendingStreamInf = parseTagAttrs(trimmed);
        continue;
      }

      if (trimmed.startsWith("#")) {
        pendingStreamInf = null;
        continue;
      }

      const url = resolve(trimmed);
      const inf = pendingStreamInf || {};
      const [w, h] = (inf.RESOLUTION || "x").split("x");
      video.push({
        url,
        bandwidth:  parseInt(inf.BANDWIDTH || "0", 10),
        resolution: inf.RESOLUTION || "",
        width:      parseInt(w || "0", 10),
        height:     parseInt(h || "0", 10),
        frameRate:  parseFloat(inf["FRAME-RATE"] || "0"),
        codecs:     inf.CODECS || "",
        audioGroup: inf.AUDIO  || "",
      });
      pendingStreamInf = null;
    }

    video.sort((a, b) => b.height - a.height);
    debug.push(`[M] Audio tracks: ${audio.length} | Video tracks: ${video.length}`);
    return { audio, video };
  } catch (e) {
    debug.push(`[M] Failed to fetch master m3u8: ${e.message}`);
    return { audio: [], video: [] };
  }
}

function extractAstroProps(html) {
  const $ = cheerio.load(html);
  const results = [];
  $("astro-island[props]").each((_, el) => {
    try {
      const raw     = $(el).attr("props") || "";
      const decoded = he.decode(decodeUnicode(raw));
      results.push(JSON.parse(decoded));
    } catch (_e) {}
  });
  $("script[type='application/json']").each((_, el) => {
    try {
      const raw     = $(el).html() || "";
      const decoded = he.decode(decodeUnicode(raw));
      results.push(JSON.parse(decoded));
    } catch (_e) {}
  });
  return results;
}

function collectStrings(obj, pattern, found = []) {
  if (typeof obj === "string") {
    if (pattern.test(obj)) found.push(obj);
  } else if (Array.isArray(obj)) {
    for (const v of obj) collectStrings(v, pattern, found);
  } else if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) collectStrings(v, pattern, found);
  }
  return found;
}

async function fetchKaaEpisodes(showSlug, lang = "ja-JP", page = 1) {
  const pageUrl = `https://kaa.lt/${showSlug}`;

  const { data: html } = await axios.get(pageUrl, {
    headers: { ...HEADERS, Referer: "https://kaa.lt/" },
    maxRedirects: 10,
  });

  const $ = cheerio.load(html);
  let kaaRaw = "";
  $("script:not([src])").each((_, el) => {
    const content = $(el).html() || "";
    if (content.includes("window.KAA")) kaaRaw = content;
  });
  const decoded    = he.decode(decodeUnicode(kaaRaw));
  const getField   = (key, src) => {
    const m = src.match(new RegExp(`${key}:"([^"]*?)"`));
    return m ? m[1] : null;
  };
  const langInPage = getField("language", decoded) || lang;

  let subDubOptions = [];
  let episodes      = [];
  let pageRanges    = [];
  let totalEps      = 0;

  try {
    const epApiUrl = `https://kaa.lt/api/show/${showSlug}/episodes?lang=${langInPage}&page=${page}`;
    const { data: epData } = await axios.get(epApiUrl, {
      headers: { ...HEADERS, Referer: pageUrl },
    });
    const rawEpisodes = Array.isArray(epData)
      ? epData
      : (epData.result || epData.episodes || epData.items || []);

    episodes = rawEpisodes.map(ep => ({
      ...ep,
      episodeId: `${showSlug}/ep-${ep.episode_number}-${ep.slug}`,
    }));
    totalEps = epData.count || epData.total || epData.totalCount || null;
  } catch (_) {}

  try {
    const { data: showData } = await axios.get(`https://kaa.lt/api/show/${showSlug}`, {
      headers: { ...HEADERS, Referer: pageUrl },
    });
    const langs =
      showData.languages  ||
      showData.streams    ||
      showData.dubOptions ||
      showData.audio      ||
      showData.lang       ||
      [];
    if (Array.isArray(langs) && langs.length > 0) {
      subDubOptions = langs.map(l => ({
        value: l.code  || l.value || l.language || l,
        label: l.label || l.name  || l.title    || l,
      }));
    }
  } catch (_) {}

  if (subDubOptions.length === 0) {
    const labelMap = {
      "ja-JP": "Japanese (SUB)",
      "en-US": "English (DUB)",
      "zh-CN": "Chinese (SUB)",
      "ko-KR": "Korean (SUB)",
    };
    subDubOptions = [{ value: langInPage, label: labelMap[langInPage] || langInPage }];
  }

  if (totalEps) {
    for (let i = 0; i < totalEps; i += 100) {
      const from = i + 1;
      const to   = Math.min(i + 100, totalEps);
      pageRanges.push({
        value: Math.floor(i / 100) + 1,
        label: `${String(from).padStart(2, "0")}-${String(to).padStart(2, "0")}`,
      });
    }
  }

  return { language: langInPage, subDub: subDubOptions, totalEps, pageRanges, episodes };
}

// ─── Enrich sparse API results with per-show detail ───────────────────────────
function mapRecentUpdate(item) {
  let poster = null;
  if (item.poster && typeof item.poster === "object") {
    const hq  = item.poster.hq || item.poster.sm || null;
    const fmt = (item.poster.formats || ["webp"])[0];
    if (hq) poster = `https://kaa.lt/image/poster/${hq}.${fmt}`;
  }

  const localeMap = { "ja-JP": "SUB", "en-US": "DUB", "zh-CN": "Chinese", "ko-KR": "SUB" };
  const locales   = Array.isArray(item.locales) ? item.locales : [];
  const languages = [...new Set(locales.map(l => localeMap[l] || l).filter(Boolean))];

  // episode_number is the latest ep number — directly on the item
  const latestEp = item.episode_number ?? null;

  // watch_uri: "/slug/ep-3-xxxxx" → extract ep slug
  const epSlugMatch  = (item.watch_uri || "").match(/\/(ep-[^/]+)$/);
  const latestEpSlug = epSlugMatch ? epSlugMatch[1] : (latestEp ? `ep-${latestEp}` : null);

  // slug from watch_uri: "/i-became-friends-.../ep-3-..." → first segment
  const slugMatch = (item.watch_uri || "").match(/^\/([^/]+)\//);
  const slug      = item.slug || (slugMatch ? slugMatch[1] : null);

  return {
    slug,
    title:    item.title_en || item.title || null,
    year:     item.year     || null,
    type:     item.type     ? item.type.toUpperCase() : null,
    status:   item.status   || null,
    latestEp,
    latestEpSlug,
    languages,
    language: languages.join(", ") || null,
    poster,
  };
}

// ─── Shape normalizer ─────────────────────────────────────────────────────────
function mapShow(item) {
  let poster = null;
  if (item.poster && typeof item.poster === "object") {
    const hq  = item.poster.hq || item.poster.sm || null;
    const fmt = (item.poster.formats || ["webp"])[0];
    if (hq) poster = `https://kaa.lt/image/poster/${hq}.${fmt}`;
  } else if (typeof item.poster === "string" && /^https?:\/\//.test(item.poster)) {
    poster = item.poster;
  }

  const localeMap = { "ja-JP": "SUB", "en-US": "DUB", "zh-CN": "Chinese", "ko-KR": "SUB" };
  const locales   = Array.isArray(item.locales) ? item.locales : [];
  const languages = [...new Set(locales.map(l => localeMap[l] || l).filter(Boolean))];

  // these come pre-resolved from getLatestEp()
  const latestEp     = item.latestEp     ?? null;
  const latestEpSlug = item.latestEpSlug ?? null;

  return {
    slug:      item.slug     || null,
    title:     item.title_en || item.title || null,
    year:      item.year     || null,
    type:      item.type     ? item.type.toUpperCase() : null,
    status:    item.status   || null,
    latestEp,
    latestEpSlug,
    languages,
    language: languages.join(", ") || null,
    poster,
  };
}

// ─── Lang helpers ─────────────────────────────────────────────────────────────
function langToApiParam(lang) {
  return { sub: "ja-JP", dub: "en-US", chinese: "zh-CN" }[lang] || null;
}
function filterByLang(lang) {
  if (lang === "all") return () => true;
  const want = lang.toLowerCase(); // "sub", "dub", "chinese"
  return (show) => {
    if (!show.languages || show.languages.length === 0) return false;
    return show.languages.some(l => l.toLowerCase() === want);
  };
}

async function getLatestEp(slug) {
  try {
    const { data } = await axios.get(`https://kaa.lt/api/show/${slug}/episodes`, {
      params: { lang: "ja-JP", page: 1 },
      headers: { ...HEADERS, Referer: "https://kaa.lt/" },
      timeout: 6000,
    });
    const eps = Array.isArray(data) ? data : (data.result || data.episodes || data.items || []);
    if (!eps.length) return { latestEp: null, latestEpSlug: null };
    // episodes are sorted ascending — last one is latest
    const last = eps[eps.length - 1];
    const epSlugMatch = (last.slug || "").match(/^(ep-[^/]+)$/);
    return {
      latestEp:     last.episode_number ?? null,
      latestEpSlug: epSlugMatch ? epSlugMatch[1] : `ep-${last.episode_number}-${last.slug}`,
    };
  } catch {
    return { latestEp: null, latestEpSlug: null };
  }
}



// ─── HTML parser (for POST body or ?html= fallback) ──────────────────────────
function parseKaaHtml(html, langFilter = "all") {
  const $ = cheerio.load(html);
  const shows = [];
  const seen  = new Set();
 
  $(".show-item").each((_, card) => {
    const $card = $(card);
 
    // ── slug ──────────────────────────────────────────────────────────────────
    let slug = null;
 
    // Card <a> href: e.g. "/tongari-boushi-no-atelier-9824/ep-4-a1f4bc"
    const cardHref  = $card.find("a.v-card").first().attr("href") || "";
    const cardMatch = cardHref.match(/^\/([a-z0-9][a-z0-9-]+-[0-9a-f]{4,8})(?:\/|$)/i);
    if (cardMatch) slug = cardMatch[1];
 
    // Title <a> href: may be relative WITHOUT leading slash
    // e.g. href="tongari-boushi-no-atelier-9824"
    if (!slug) {
      const titleHref  = $card.find(".show-title a").first().attr("href") || "";
      // strip optional leading slash, then match the full slug
      const titleMatch = titleHref.replace(/^\//, "")
        .match(/^([a-z0-9][a-z0-9-]+-[0-9a-f]{4,8})(?:\/|$)?$/i);
      if (titleMatch) slug = titleMatch[1];
    }
 
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
 
    // ── title ─────────────────────────────────────────────────────────────────
    const title = $card.find(".show-title a span").first().text().trim() || null;
 
    // ── poster ────────────────────────────────────────────────────────────────
    // The raw style attr looks like:
    //   background-image: url("__https://kaa.lt/image/poster/foo-hq.webp__;");
    // OR the normal:
    //   background-image: url("https://kaa.lt/image/poster/foo-hq.webp");
    // We need to strip leading __ and trailing __; / trailing garbage
    const bgStyle = $card.find(".v-image__image").first().attr("style") || "";

    // Extract whatever is inside url(...)
    const urlMatch = bgStyle.match(/url\(\s*["']?\s*(.*?)\s*["']?\s*\)/);
    let poster = null;
    if (urlMatch) {
      let raw = urlMatch[1].trim();
      // Strip leading __ prefix and trailing __; or __ suffix added by the site
      raw = raw.replace(/^__+/, "").replace(/__+;?$/, "").trim();
      if (raw.startsWith("//")) raw = "https:" + raw;
      if (raw.startsWith("/")) raw = "https://kaa.lt" + raw;
      if (/^https?:\/\//.test(raw)) poster = raw;
    }
 
    // ── chips ─────────────────────────────────────────────────────────────────
    const chips = $card.find(".v-chip__content")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
 
    // ── year ──────────────────────────────────────────────────────────────────
    const yearChip = chips.find(c => /^\d{4}$/.test(c));
    const year     = yearChip ? parseInt(yearChip, 10) : null;
 
    // ── type ──────────────────────────────────────────────────────────────────
    const typeChip = chips.find(c => /^(TV|Movie|OVA|ONA|Special)$/i.test(c));
    const type     = typeChip ? typeChip.toUpperCase() : null;
 
    // ── latest episode ────────────────────────────────────────────────────────
    const epChip   = chips.find(c => /^EP\s*\d+$/i.test(c));
    const latestEp = epChip ? parseInt(epChip.replace(/\D/g, ""), 10) : null;
 
    // ── latest episode slug (from card href) ──────────────────────────────────
    const epSlugMatch  = cardHref.match(/\/(ep-[^/]+)$/i);
    const latestEpSlug = epSlugMatch ? epSlugMatch[1] : null;
 
    // ── language chips ────────────────────────────────────────────────────────
    const languages = chips.filter(c => /^(SUB|DUB|Chinese)$/i.test(c));
 
    // ── lang filter ───────────────────────────────────────────────────────────
    if (langFilter !== "all") {
      const want = langFilter.toLowerCase();
      const has  = languages.some(l => l.toLowerCase() === want);
      if (!has) return;
    }
 
    shows.push({
      slug,
      title,
      poster,
      year,
      type,
      latestEp,
      latestEpSlug,
      languages,
      language: languages.join(", ") || null,
    });
  });
 
  return shows;
}
 
 
// ─── /browse (replace the existing route) ────────────────────────────────────
// ─── /browse ─────────────────────────────────────────────────────────────────
 
router.get("/debug-home-endpoints", async (req, res) => {
  const endpoints = [
    "/api/top_airing",
    "/api/today_releases", 
    "/api/recent_update",
    "/api/trending",
    "/api/popular",
    "/api/featured",
    "/api/home",
  ];

  const results = await Promise.allSettled(
    endpoints.map(ep =>
      axios.get(`https://kaa.lt${ep}`, {
        params: { page: 1, limit: 10 },
        headers: { ...HEADERS, Referer: "https://kaa.lt/" },
        timeout: 8000,
      }).then(r => ({ endpoint: ep, status: r.status, sample: JSON.stringify(r.data).slice(0, 300) }))
    )
  );

  res.json(results.map(r => r.status === "fulfilled" ? r.value : { error: r.reason?.message, endpoint: r.reason?.config?.url }));
});

// ─── / ───────────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "KAA Scraper API",
    routes: [
      {
        method: "GET",
        path: "/",
        description: "List all routes",
        example: "http://localhost:3000/",
      },
      {
        method: "GET",
        path: "/episodes/:showSlug",
        description: "Get episode list, sub/dub options and page ranges for a KAA show.",
        params: {
          showSlug: "Show slug e.g. one-piece-0948 (URL param)",
          page:     "Page number for episode list, default 1",
          lang:     "Language code, default ja-JP",
        },
        examples: [
          "/anime/kissanime/episodes/one-piece-0948?page=1",
          "/anime/kissanime/episodes/one-piece-0948?page=2",
        ],
      },
      {
        method: "GET",
        path: "/anilist/:anilistId",
        description: "Full AniList + TMDB metadata merged with provider episode list.",
        params: {
          anilistId: "AniList media ID e.g. 21",
          provider:  "Provider name e.g. kissanime (default: kissanime)",
          page:      "Episode page number, default 1",
          lang:      "Language code, default ja-JP",
          apiKey:    "API key (required)",
        },
        examples: [
          "/anime/kissanime/anilist/21?provider=kissanime&page=1&apiKey=fuckyoubitch",
        ],
      },
      {
        method: "GET",
        path: "/source/:showSlug/:epSlug",
        description: "Scrape m3u8, audio, video tracks and subtitles from a kaa.lt episode.",
        params: {
          showSlug: "Show slug e.g. one-piece-0948",
          epSlug:   "Episode slug e.g. ep-1-225ebd",
        },
        examples: [
          "/anime/kissanime/source/one-piece-0948/ep-1-225ebd",
        ],
      },
      {
        method: "GET",
        path: "/browse",
        description: "Browse or search the kaa.lt show listing via JSON API, with HTML fallback.",
        params: {
          lang:   "Filter: all | sub | dub | chinese (default: all)",
          page:   "Page number (default: 1)",
          limit:  "Results per page (default: 30)",
          q:      "Search query (optional)",
        },
        examples: [
          "/anime/kissanime/browse",
          "/anime/kissanime/browse?lang=sub&page=2",
          "/anime/kissanime/browse?lang=dub",
          "/anime/kissanime/browse?q=one+piece",
        ],
      },
      {
        method: "GET",
        path: "/playlist",
        description: "Proxy and return a raw m3u8 master playlist.",
        params: { url: "master.m3u8 URL (required)" },
      },
      {
        method: "GET",
        path: "/proxy",
        description: "Proxy any HLS segment or sub-playlist stream.",
        params: { url: "segment or playlist URL (required)" },
      },
      {
        method: "GET",
        path: "/vtt",
        description: "Proxy and return a VTT subtitle file.",
        params: { url: "VTT subtitle URL (required)" },
      },
      {
        method: "GET",
        path: "/debug-master",
        description: "Fetch and return the raw text content of a master m3u8.",
        params: { url: "master.m3u8 URL (required)" },
      },
    ],
  });
});

router.get("/debug-api", async (req, res) => {
  const { data } = await axios.get("https://kaa.lt/api/anime", {
    params: { page: 1, limit: 5 },
    headers: { ...HEADERS, Referer: "https://kaa.lt/" },
    timeout: 12000,
  });
  res.json(data);
});
// ─── /browse ─────────────────────────────────────────────────────────────────
router.get("/browse", async (req, res) => {
  const lang   = (req.query.lang  || "all").toLowerCase();
  const search = (req.query.q     || "").trim();
  const page   = parseInt(req.query.page  || "1",  10);
  const limit  = parseInt(req.query.limit || "30", 10);

  try {
    let raw = [];

    if (search) {
      for (const params of [{ q: search }, { search }, { keyword: search }]) {
        try {
          const { data } = await axios.get("https://kaa.lt/api/anime", {
            params: { ...params, page, limit },
            headers: { ...HEADERS, Referer: "https://kaa.lt/" },
            timeout: 8000,
          });
          const items = Array.isArray(data) ? data : (data.result || data.results || data.items || data.data || []);
          if (items.length > 0) { raw = items; break; }
        } catch (_) {}
      }
    } else {
      const { data } = await axios.get("https://kaa.lt/api/recent_update", {
        params: { page, limit },
        headers: { ...HEADERS, Referer: "https://kaa.lt/" },
        timeout: 8000,
      });
      raw = Array.isArray(data) ? data : (data.result || data.results || data.items || data.data || []);
    }

    const shows = raw.map(mapRecentUpdate).filter(filterByLang(lang)).slice(0, limit);

    return res.json({ lang, search: search || null, page, source: "recent_update", count: shows.length, shows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ─── /episodes/:showSlug ──────────────────────────────────────────────────────
router.get("/episodes/:showSlug", async (req, res) => {
  const { showSlug } = req.params;
  if (!showSlug) return res.status(400).json({ error: "Missing showSlug param" });

  const page = parseInt(req.query.page || "1", 10);
  const lang = req.query.lang || "ja-JP";

  try {
    const data = await fetchKaaEpisodes(showSlug, lang, page);
    res.json({ showSlug, page, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /anilist/:anilistId ──────────────────────────────────────────────────────
router.get("/anilist/:anilistId", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { anilistId } = req.params;
  const provider      = (req.query.provider || "kissanime").toLowerCase();
  const page          = parseInt(req.query.page || "1", 10);
  const lang          = req.query.lang || "ja-JP";

  if (!anilistId) return res.status(400).json({ error: "Missing anilistId param" });

  const resolver = PROVIDER_RESOLVERS[provider];
  if (!resolver) {
    return res.status(400).json({
      error: `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDER_RESOLVERS).join(", ")}`,
    });
  }

  try {
    const rawMedia = await fetchAnilistMedia(anilistId);
    if (!rawMedia) {
      return res.status(404).json({ error: `AniList media not found for id: ${anilistId}` });
    }
    const mappedMedia = mapAnilistMedia(rawMedia);

    const [tmdbResult, showSlug] = await Promise.all([
      resolveTMDB(rawMedia),
      resolver(rawMedia),
    ]);
    const { tmdbId, tmdbInfo, tmdbLookup } = tmdbResult;

    let providerEpisodes = null;
    let providerError    = null;

    if (showSlug) {
      try {
        providerEpisodes = await fetchKaaEpisodes(showSlug, lang, page);
      } catch (e) {
        providerError = e.message;
      }
    }

    const mergedEpisodes = (providerEpisodes?.episodes || []).map(ep => {
      const epNum  = ep.episode_number ?? ep.episodeNumber ?? null;
      const tmdbEp = epNum != null ? tmdbLookup.get(epNum) : null;
      return {
        ...ep,
        ...(tmdbEp?.title         && { title:         tmdbEp.title }),
        ...(tmdbEp?.overview      && { overview:       tmdbEp.overview }),
        ...(tmdbEp?.airDate       && { airDate:        tmdbEp.airDate }),
        ...(tmdbEp?.aired != null  && { aired:         tmdbEp.aired }),
        ...(tmdbEp?.rating        && { rating:         tmdbEp.rating }),
        ...(tmdbEp?.thumbnail     && { thumbnail:      tmdbEp.thumbnail }),
        ...(tmdbEp?.seasonNumber  != null && { seasonNumber: tmdbEp.seasonNumber }),
        episodeNumber: tmdbEp?.episodeNumber ?? epNum,
      };
    });

    res.json({
      anilistId:     parseInt(anilistId),
      ...mappedMedia,
      tmdbId,
      tmdb:          tmdbInfo || null,
      provider,
      showSlug:      showSlug      || null,
      providerError: providerError || null,
      page,
      totalEps:      providerEpisodes?.totalEps  || null,
      pageRanges:    providerEpisodes?.pageRanges || [],
      subDub:        providerEpisodes?.subDub     || [],
      language:      providerEpisodes?.language   || lang,
      episodes:      mergedEpisodes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /source/:showSlug/:epSlug ────────────────────────────────────────────────
router.get("/source/:showSlug/:epSlug", async (req, res) => {
  const { showSlug, epSlug } = req.params;
    const pageUrl = `https://kaa.lt/${showSlug}/${epSlug}`;

 const [anilistId, { data: html }] = await Promise.all([
    resolveAnilistIdFromSlug(showSlug),
    axios.get(pageUrl, {
      headers: { ...HEADERS, Referer: "https://kaa.lt/" },
      maxRedirects: 10,
    }),
  ]);
 
  try {
    const { data: html } = await axios.get(pageUrl, {
      headers: { ...HEADERS, Referer: "https://kaa.lt/" },
      maxRedirects: 10,
    });

    const $ = cheerio.load(html);
    let kaaRaw = "";
    $("script:not([src])").each((_, el) => {
      const content = $(el).html() || "";
      if (content.includes("window.KAA")) kaaRaw = content;
    });
    const kaaDecoded = he.decode(decodeUnicode(kaaRaw));

    const srcMatches = [
      ...[...kaaDecoded.matchAll(/"src"\s*:\s*"(https?:\/\/[^"]+)"/g)].map(m => m[1]),
      ...[...kaaDecoded.matchAll(/'src'\s*:\s*'(https?:\/\/[^']+)'/g)].map(m => m[1]),
      ...[...kaaDecoded.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/g)].map(m => m[1]),
      ...[...kaaDecoded.matchAll(/"file"\s*:\s*"(https?:\/\/[^"]+)"/g)].map(m => m[1]),
      ...[...kaaDecoded.matchAll(/(https?:\/\/[^\s"'\\>]*krussdomi[^\s"'\\>]*)/g)].map(m => m[1]),
    ];
    const uniqueSrcs = [...new Set(srcMatches)];

    const results = [];

    for (const playerUrl of uniqueSrcs) {
      try {
        const { data: playerHtml } = await axios.get(playerUrl, {
          headers: { ...HEADERS, Referer: pageUrl },
          maxRedirects: 10,
        });

        const decoded = he.decode(decodeUnicode(playerHtml));

        let m3u8Raw = [
          ...new Set([
            ...(decoded.match(/https?:\/\/[^\s"'\\>]+\.m3u8[^\s"'\\>]*/g) || []),
            ...(decoded.match(/\/\/[a-zA-Z0-9][^\s"'\\>]+\.m3u8[^\s"'\\>]*/g) || []),
          ])
        ];
        let m3u8Hits = [...new Set(m3u8Raw.map(fixUrl).filter(isAbsoluteUrl))];

        const astroProps = extractAstroProps(playerHtml);
        for (const props of astroProps) {
          const fromProps = collectStrings(props, /\.m3u8/).map(fixUrl).filter(isAbsoluteUrl);
          m3u8Hits = [...new Set([...m3u8Hits, ...fromProps])];
        }

        const catIdMatch = playerUrl.match(/[?&]id=([A-Za-z0-9+/=]+).*source=catstream/);
        if (catIdMatch && m3u8Hits.length === 0) {
          try {
            const decoded64 = Buffer.from(catIdMatch[1], "base64").toString("utf8");
            const videoId   = decoded64.split(":")[0];
            if (videoId && /^[a-f0-9]{24}$/.test(videoId)) {
              m3u8Hits.push(`https://bl.krussdomi.com/playlist/${videoId}/master.m3u8`);
            }
          } catch (_) {}
        }

        const debug    = [];
        let allAudio   = [];
        let allVideo   = [];
        for (const masterUrl of m3u8Hits) {
          const { audio, video } = await fetchMasterPlaylist(masterUrl, pageUrl, debug);
          allAudio.push(...audio);
          allVideo.push(...video);
        }

        const vttRaw    = [...new Set(decoded.match(/https?:\/\/[^\s"'\\>]+\.vtt[^\s"'\\>]*/g) || [])];
        const srtRaw    = [...new Set(decoded.match(/https?:\/\/[^\s"'\\>]+\.srt[^\s"'\\>]*/g) || [])];
        const allVttRaw = [...vttRaw];
        const allSrtRaw = [...srtRaw];
        for (const props of astroProps) {
          allVttRaw.push(...collectStrings(props, /\.vtt$/));
          allSrtRaw.push(...collectStrings(props, /\.srt$/));
        }
        const subtitles = {
          vtt: [...new Set(allVttRaw.map(fixUrl).filter(isAbsoluteUrl))],
          srt: [...new Set(allSrtRaw.map(fixUrl).filter(isAbsoluteUrl))],
        };

        const sourceMatch = playerUrl.match(/source=([^&]+)/);
        const source      = sourceMatch ? sourceMatch[1] : "unknown";

        results.push({ source, playerUrl, m3u8: m3u8Hits, audio: allAudio, video: allVideo, subtitles });
      } catch (_) {}
    }

    res.json({
      episodeId: `${showSlug}/${epSlug}`,
      anilistId,                              
      m3u8:    results.flatMap(r => r.m3u8),
      audio:   results.flatMap(r => r.audio),
      video:   results.flatMap(r => r.video),
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /playlist ────────────────────────────────────────────────────────────────
router.get("/playlist", async (req, res) => {
  const m3u8Url = req.query.url || "https://bl.krussdomi.com/playlist/69c6bcd2ab00ea3267443866/master.m3u8";
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        ...HEADERS,
        Referer: "https://kaa.lt/",
        Origin: "https://kaa.lt",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "text",
    });
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /proxy ───────────────────────────────────────────────────────────────────
router.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Missing ?url= param" });
  try {
    const response = await axios.get(target, {
      headers: {
        ...HEADERS,
        Referer: "https://kaa.lt/",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "stream",
    });
    res.setHeader("Content-Type", response.headers["content-type"] || "application/octet-stream");
    res.setHeader("Access-Control-Allow-Origin", "*");
    response.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /vtt ─────────────────────────────────────────────────────────────────────
router.get("/vtt", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Missing ?url= param" });
  try {
    const response = await axios.get(target, {
      headers: {
        ...HEADERS,
        Referer: "https://kaa.lt/",
        Origin: "https://kaa.lt",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "arraybuffer",
    });
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", response.data.byteLength);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(response.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.get("/debug-html", async (req, res) => {
  const { data: html } = await axios.get("https://kaa.lt/", {
    headers: { ...HEADERS, Referer: "https://kaa.lt/" },
    timeout: 10000,
  });

  const $ = cheerio.load(html);

  // Log what class names actually exist
  const classes = new Set();
  $("[class]").each((_, el) => {
    const c = $(el).attr("class") || "";
    c.split(/\s+/).forEach(cls => cls && classes.add(cls));
  });

  res.json({
    htmlLength: html.length,
    hasShowItem: html.includes("show-item"),
    hasVCard: html.includes("v-card"),
    firstShowItemHtml: $(".show-item").first().html()?.slice(0, 500) || null,
    allClasses: [...classes].slice(0, 100),
    rawSnippet: html.slice(0, 2000),
  });
});
// ─── /debug-master ────────────────────────────────────────────────────────────
router.get("/debug-master", async (req, res) => {
  const m3u8Url = req.query.url;
  if (!m3u8Url) return res.status(400).json({ error: "Missing ?url= param" });
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        ...HEADERS,
        Referer: "https://kaa.lt/",
        Origin: "https://kaa.lt",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "text",
    });
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/", router);

export default router;