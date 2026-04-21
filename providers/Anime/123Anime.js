import { Router } from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import {
  extractExternalIds,
  fetchAnilistMedia,
  resolveTMDB,
} from '../Anime/meta/graphqltmbd.js';

const router = Router();

// ─── HTTP clients ─────────────────────────────────────────────────────────────
const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: '*/*',
  },
});

const httpProbe = axios.create({
  timeout: 4000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html',
  },
});

// ─── In-memory cache ──────────────────────────────────────────────────────────
const _cache = new Map();

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { _cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value, ttlMs = 6 * 60 * 60 * 1000) {
  _cache.set(key, { value, expires: Date.now() + ttlMs });
}

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE = 'https://w1.123animes.ru';

// ─── Slug helpers ─────────────────────────────────────────────────────────────
const JP_NUMBER_WORDS = {
  ichi: '1', ni: '2', san: '3', shi: '4', yon: '4',
  go: '5', roku: '6', shichi: '7', nana: '7', hachi: '8',
  ku: '9', kyuu: '9', juu: '10',
};

function toSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function applyNumberWords(slug) {
  let result = slug;
  for (const [word, digit] of Object.entries(JP_NUMBER_WORDS)) {
    result = result.replace(new RegExp(`(?<=-|^)${word}(?=-|$)`, 'g'), digit);
  }
  return result;
}

function getFusedVariants(slug) {
  const variants = new Set();
  const re = /-([a-z]{1,2})-([a-z]{1,2})(?=-|$)/g;
  let m;
  while ((m = re.exec(slug)) !== null) {
    const before = slug.slice(0, m.index);
    const after  = slug.slice(m.index + m[0].length);
    variants.add(`${before}-${m[1]}${m[2]}${after}`);
    re.lastIndex = m.index + 1;
  }
  let allFused = slug;
  for (let i = 0; i < 2; i++) {
    allFused = allFused
      .replace(/-([a-z]{1,2})-([a-z]{1,2})-/g, (_, a, b) => `-${a}${b}-`)
      .replace(/-([a-z]{1,2})-([a-z]{1,2})$/, (_, a, b) => `-${a}${b}`);
  }
  if (allFused !== slug) variants.add(allFused);
  return variants;
}

function slugVariations(title) {
  const base    = toSlug(title);
  const numeric = applyNumberWords(base);

  const priority = [base, base + '-tv', numeric, numeric + '-tv'];
  const rest = new Set();
  const dubVariants = new Set(); // ← NEW: collect dub variants separately
  const roots = [...new Set([base, numeric])];

  for (const root of roots) {
    rest.add(root);
    for (const fused of getFusedVariants(root)) {
      rest.add(fused);
      rest.add(fused + '-tv');
      dubVariants.add(fused + '-dub'); // ← moved to dub bucket
    }
    dubVariants.add(root + '-dub');         // ← moved
    dubVariants.add(root + '-sub');         // ← moved
    dubVariants.add(root + '-english-dub'); // ← moved
    rest.add(root + '-ova');
    rest.add(root + '-ona');
    const stripped = root
      .replace(/-season-\d+$/, '')
      .replace(/-part-\d+$/, '')
      .replace(/-\d+$/, '');
    if (stripped !== root) {
      rest.add(stripped);
      rest.add(stripped + '-tv');
      for (const fused of getFusedVariants(stripped)) rest.add(fused);
    }
  }

  const seen = new Set(priority);
  const all  = [...priority];
  for (const s of rest) {
    if (!seen.has(s)) { seen.add(s); all.push(s); }
  }
  // Append dub variants at the END so they only match if nothing else does
  for (const s of dubVariants) {
    if (!seen.has(s)) { seen.add(s); all.push(s); }
  }
  return all.filter(s => s.length > 1);
}

// ─── Slug existence check ─────────────────────────────────────────────────────
async function checkSlugExists(slug) {
  try {
    const r = await httpProbe.get(`${BASE}/anime/${slug}`, {
      headers: { Referer: 'https://www.google.com/' },
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (r.status !== 200) return false;
    const html = typeof r.data === 'string' ? r.data : '';
    const lowerHtml = html.toLowerCase();
    return (
      lowerHtml.includes(`/anime/${slug}`) ||
      lowerHtml.includes('data-id') ||
      lowerHtml.includes('episode') ||
      lowerHtml.includes('watch-now')
    );
  } catch { return false; }
}

// ─── Slug → AniList reverse lookup ───────────────────────────────────────────
async function resolveAnilistIdFromSlug(slug) {
  const cacheKey = `anilist_from_slug_${slug}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const title = slug.replace(/-/g, ' ');
  try {
    const { data } = await http.post('https://graphql.anilist.co', {
      query: `
        query ($search: String) {
          Media(search: $search, type: ANIME) {
            id
          }
        }
      `,
      variables: { search: title },
    }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    const id = data?.data?.Media?.id || null;
    if (id) cacheSet(cacheKey, id, 24 * 60 * 60 * 1000);
    return id;
  } catch {
    return null;
  }
}

async function checkSlugsBatch(slugs, concurrency = 8) {
  const queue = [...slugs];
  return new Promise((resolve) => {
    let found  = false;
    let active = 0;
    let idx    = 0;

    function next() {
      if (found) return;
      if (idx >= queue.length && active === 0) { resolve(null); return; }
      while (active < concurrency && idx < queue.length) {
        const slug = queue[idx++];
        active++;
        checkSlugExists(slug).then((exists) => {
          active--;
          if (exists && !found) { found = true; resolve(slug); return; }
          if (!found) next();
        }).catch(() => { active--; if (!found) next(); });
      }
    }

    next();
  });
}

async function search123Slug(titles) {
  const asciiTitles = titles.filter(t => t && !/[^\x00-\x7F]/.test(t));

  for (const title of asciiTitles) {
    // ── Priority pass: non-dub slugs only ──────────────────────────────────
    const allVariants = slugVariations(title);
    const nonDubVariants = allVariants.filter(s => !isDubSlug(s));
    
    const slug = await checkSlugsBatch(nonDubVariants, 8);
    if (slug) {
      console.log(`[123animes] Direct slug hit: "${slug}" (from "${title}")`);
      return slug;
    }
  }

  // ── Fallback: search page (also exclude dub results) ─────────────────────
  for (const title of asciiTitles) {
    try {
      const { data } = await http.get(`${BASE}/?s=${encodeURIComponent(title)}`, {
        headers: { Referer: 'https://www.google.com/' },
      });
      const $ = cheerio.load(data);
      const allAnimeLinks = new Map();

      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/anime\/([^\/\?#]+)/);
        if (!m) return;
        const slug = m[1];
        if (['list', 'filter', 'search'].includes(slug) || slug.length < 2) return;
        if (isDubSlug(slug)) return; // ← skip dub slugs from search results
        const text = $(el).text().trim();
        if (!allAnimeLinks.has(slug)) allAnimeLinks.set(slug, text);
      });

      if (!allAnimeLinks.size) continue;

      const titleLower = title.toLowerCase();
      const titleSlug  = toSlug(title);
      const titleWords = titleLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1);

      const scored = Array.from(allAnimeLinks.entries()).map(([slug, text]) => {
        const sSlug = slug.toLowerCase();
        const sText = text.toLowerCase();
        let score = 0;
        if (sSlug === titleSlug)              score += 200;
        else if (sSlug.startsWith(titleSlug)) score += 100;
        else if (sSlug.includes(titleSlug))   score += 60;
        if (sText === titleLower)             score += 150;
        else if (sText.includes(titleLower))  score += 50;
        const matched = titleWords.filter(w => sSlug.includes(w) || sText.includes(w));
        score += (matched.length / Math.max(titleWords.length, 1)) * 40;
        if (matched.length >= titleWords.length * 0.75) score += 30;
        return { slug, text, score };
      }).sort((a, b) => b.score - a.score);

      if (scored[0]?.score >= 15) return scored[0].slug;
    } catch (e) {
      console.warn(`[123animes] Search "${title}" failed:`, e.message);
    }
  }

  return null;
}

// ─── Dub slug detection ───────────────────────────────────────────────────────
const DUB_SUFFIXES = ['-dub', '-english-dub', '-dubbed'];

function isDubSlug(slug) {
  return DUB_SUFFIXES.some(suffix => slug.endsWith(suffix));
}


async function findDubSlug(mainSlug) {
  const results = await Promise.all(
    DUB_SUFFIXES.map(async (suffix) => {
      const dubSlug = mainSlug + suffix;
      const exists  = await checkSlugExists(dubSlug);
      return exists ? dubSlug : null;
    })
  );
  return results.find(Boolean) || null;
}

// ─── Scraping ─────────────────────────────────────────────────────────────────
async function fetchEpisodeList(slug) {
  const ts = Date.now();
  const { data } = await http.get(`${BASE}/ajax/film/sv?id=${slug}&ts=001&_=${ts}`, {
    headers: { Referer: `${BASE}/anime/${slug}`, 'X-Requested-With': 'XMLHttpRequest' },
  });

  const html = typeof data === 'object' ? (data.html || data.content || '') : data;
  const $    = cheerio.load(html);
  const episodes = [];

  $('a[data-id]').each((_, el) => {
    const $a    = $(el);
    const base  = $a.attr('data-base');
    const href  = $a.attr('href');
    const num   = parseInt(base || $a.text().trim(), 10);
    const parts = ($a.attr('data-id') || '').split('/');
    const epSlug = parts[0] || slug;
    const epNum  = parts[1] || String(num);
    const liId   = $a.closest('li').attr('id');

    if (!isNaN(num)) {
      episodes.push({
        episode:   num,
        label:     `Episode ${num}`,
        slug:      epSlug,
        episodeId: `${epSlug}/episode/${epNum}`,
        url:       href ? `${BASE}${href}` : '',
        m3u8:      `https://hlsx3cdn.echovideo.to/${epSlug}/${epNum}/master.m3u8`,
        isFirst:   liId === 'str',
        isLast:    liId === 'end',
      });
    }
  });

  return episodes;
}

async function scrapeAnimePage(slug) {
  const { data: html } = await http.get(`${BASE}/anime/${slug}`, {
    headers: { Referer: 'https://www.google.com/' },
  });
  const $ = cheerio.load(html);
  const result = { slug };

  result.title =
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') || '';

  result.cover =
    $('meta[property="og:image"]').attr('content') ||
    $('img[src*="/imgs/poster/"]').first().attr('src') || '';
  if (result.cover?.startsWith('/')) result.cover = BASE + result.cover;

  result.synopsis = $('meta[property="og:description"]').attr('content') || '';

  result.genres = [];
  $('a[href*="/genere/"]').each((_, el) => {
    const g = $(el).text().trim();
    if (g && !result.genres.includes(g)) result.genres.push(g);
  });

  result.info = {};
  $('dl dt').each((_, dt) => {
    const key = $(dt).text().replace(':', '').trim();
    const val = $(dt).next('dd').text().trim();
    if (key && val) result.info[key] = val;
  });

  result.episodes      = await fetchEpisodeList(slug);
  result.totalEpisodes = result.episodes.length;
  return result;
}

// ─── TMDB episode merge ───────────────────────────────────────────────────────
function mergeEpisodesWithTMDB(episodes, lookup) {
  return episodes.map((ep) => {
    const meta = lookup.get(Number(ep.episode));
    if (!meta) return ep;
    return {
      ...ep,
      ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null)),
    };
  });
}

// ─── Shared enrichment logic ──────────────────────────────────────────────────
async function enrichWithDubAndTMDB(data, dubSlug, media = null) {
  const dubData = dubSlug ? await scrapeAnimePage(dubSlug) : null;

  let tmdbId     = null;
  let tmdbLookup = new Map();

  if (media) {
    const resolved = await resolveTMDB(media);
    tmdbId     = resolved.tmdbId;
    tmdbLookup = resolved.tmdbLookup;
  }

  if (tmdbLookup.size) {
    data.episodes     = mergeEpisodesWithTMDB(data.episodes, tmdbLookup);
    if (dubData) dubData.episodes = mergeEpisodesWithTMDB(dubData.episodes, tmdbLookup);
    data.enriched     = true;
    data.metaSource   = 'tmdb';
    data.tmdbSeriesId = tmdbId;
  } else {
    data.enriched = false;
  }

  data.hasDub  = dubSlug !== null;
  data.dubSlug = dubSlug;

  if (dubSlug && dubData?.episodes?.length) {
    const dubByNum = new Map(dubData.episodes.map(ep => [ep.episode, ep]));
    data.episodes = data.episodes.map(ep => {
      const dubEp = dubByNum.get(ep.episode);
      if (!dubEp) return ep;
      return {
        ...ep,
        dub: {
          slug:      dubEp.slug,
          episodeId: dubEp.episodeId,
          url:       dubEp.url,
          m3u8:      dubEp.m3u8,
        },
      };
    });
  }

  return data;
}

// ─── Recent pages ─────────────────────────────────────────────────────────────
const RECENT_PATHS = {
  'subbed-anime':  '/subbed-anime/',
  'dubbed-anime':  '/dubbed-anime/',
  'chinese-anime': '/chinese-anime',
};

async function scrapeRecentPage(type, page = 1) {
  const path = RECENT_PATHS[type];
  if (!path) throw new Error(`Unknown type: ${type}`);

  const url = `${BASE}${path}/?page=${page}`;
  const { data: html } = await http.get(url, {
    headers: { Referer: 'https://www.google.com/' },
  });
  const $ = cheerio.load(html);
  const items = [];

  $('.item').each((_, el) => {
    const $el     = $(el);
    const $anchor = $el.find('a.poster');
    const href    = $anchor.attr('href') || '';
    const slug    = (href.match(/\/anime\/([^\/\?#]+)/) || [])[1] || null;

    const title  = $el.find('a.name').text().trim() || $anchor.find('img').attr('alt') || '';
    const cover  = $anchor.find('img').attr('data-src') || $anchor.find('img').attr('src') || '';
    const epText = $el.find('.ep').text().trim();
    const epNum  = parseInt((epText.match(/\d+/) || [])[0], 10) || null;
    const status = $el.find('.status .sub, .status .dub').first().text().trim().toUpperCase() || null;

    if (!slug) return;
    items.push({
  slug,
  title,
  cover:         cover.startsWith('/') ? BASE + cover : cover,
  latestEpisode: epNum,
  episodeId:     epNum != null ? `${slug}/episode/${epNum}` : null,
  status,
  url:           `${BASE}/anime/${slug}`,
});
  });

  let totalPages = null;
  const lastPageHref = $('a[href*="?page="]:last, .pagination a:last').attr('href') || '';
  const lastPageNum  = parseInt((lastPageHref.match(/page=(\d+)/) || [])[1], 10);
  if (!isNaN(lastPageNum)) totalPages = lastPageNum;

  return { page, totalPages, count: items.length, items };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /anime/123animes
router.get('/', (req, res) => {
  res.json({
    provider: '123animes',
    base: BASE,
    endpoints: [
      {
        method: 'GET',
        path: '/anime/123anime/details/:anilistId',
        details: 'fetch by AniList ID with TMDB enrichment + dub',
        example: '/anime/123anime/details/21'
      },
      {
        method: 'GET',
        path: '/slug/:slug',
        details: 'fetch by 123animes slug directly',
        example: '/anime/123anime/slug/naruto'
      },
     {
  method: 'GET',
  path: '/watch/:slug/episode/:episode',
  details: 'get M3U8 stream URLs',
  example: '/anime/123anime/watch/naruto/episode/1'
},
      {
        method: 'GET',
        path: '/anime/123anime/recent/:type?page=N',
        details: 'recently updated anime (subbed-anime|dubbed-anime|chinese-anime)',
        example: '/anime/123anime/recent/subbed-anime?page=1'
      },
      {
        method: 'GET',
        path: '/debug/:anilistId',
        details: 'diagnose slug resolution',
        example: '/anime/123anime/debug/21'
      }
    ],
  });
});

// GET /anime/123animes/details/:anilistId
router.get('/details/:anilistId', async (req, res) => {
  const { anilistId } = req.params;

  try {
    const media = await fetchAnilistMedia(anilistId);
    if (!media) return res.status(404).json({ success: false, error: 'AniList ID not found' });

    const externalIds = extractExternalIds(media);
    const allTitles   = [
      media.title?.english,
      media.title?.romaji,
      media.title?.native,
      ...(media.synonyms || []),
    ].filter(Boolean);

    const slugCacheKey = `slug_123_${anilistId}`;
    let slug = cacheGet(slugCacheKey);
    if (!slug) {
      slug = await search123Slug(allTitles);
      if (slug) cacheSet(slugCacheKey, slug, 24 * 60 * 60 * 1000);
    }
    if (!slug) {
      return res.status(404).json({
        success: false,
        error: 'Could not find this anime on 123animes',
        anilistId,
        searchedTitles: allTitles,
      });
    }

    const dubSlugCacheKey = `slug_123_dub_${anilistId}`;
    let dubSlugRaw = cacheGet(dubSlugCacheKey);
    if (dubSlugRaw === null) {
      const found = await findDubSlug(slug);
      dubSlugRaw = found || '';
      cacheSet(dubSlugCacheKey, dubSlugRaw, 24 * 60 * 60 * 1000);
    }
    const dubSlug = dubSlugRaw || null;

    let data = await scrapeAnimePage(slug);
    data = await enrichWithDubAndTMDB(data, dubSlug, media);

    data.anilistId   = parseInt(anilistId);
    data.externalIds = externalIds;

    res.json({ success: true, data });
  } catch (err) {
    console.error('[123animes /details] error:', err.message);
    res.status(500).json({ success: false, anilistId, error: err.message });
  }
});

// GET /anime/123animes/slug/:slug
router.get('/slug/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const exists = await checkSlugExists(slug);
    if (!exists) {
      return res.status(404).json({
        success: false,
        error: `Slug "${slug}" not found on 123animes`,
        slug,
      });
    }

    const dubSlugCacheKey = `slug_123_dub_slug_${slug}`;
    let dubSlugRaw = cacheGet(dubSlugCacheKey);
    if (dubSlugRaw === null) {
      const found = await findDubSlug(slug);
      dubSlugRaw = found || '';
      cacheSet(dubSlugCacheKey, dubSlugRaw, 24 * 60 * 60 * 1000);
    }
    const dubSlug = dubSlugRaw || null;

    let data = await scrapeAnimePage(slug);
    data = await enrichWithDubAndTMDB(data, dubSlug);

    res.json({ success: true, data });
  } catch (err) {
    console.error('[123animes /slug] error:', err.message);
    res.status(500).json({ success: false, slug, error: err.message });
  }
});

// GET /anime/123animes/watch/:slug/:episode
router.get('/watch/:slug/episode/:episode', async (req, res) => {
  const { slug, episode } = req.params;

  try {
    const [m3u8Response, anilistId] = await Promise.all([
      http.get(`https://hlsx3cdn.echovideo.to/${slug}/${episode}/master.m3u8`, {
        headers: { Referer: `${BASE}/anime/${slug}/episode/${episode}`, Origin: 'https://hlsx3cdn.echovideo.to' },
      }),
      resolveAnilistIdFromSlug(slug),
    ]);

    const lines = m3u8Response.data.split('\n').map((l) => l.trim()).filter(Boolean);
    const streams = [];
    let meta = {};
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const attrs = {};
        const re = /(\w[\w-]*)=("([^"]+)"|([^,\s]+))/g;
        let m;
        while ((m = re.exec(line)) !== null) attrs[m[1]] = m[3] ?? m[4];
        meta = attrs;
      } else if (!line.startsWith('#') && meta.BANDWIDTH) {
        streams.push({ ...meta, url: line.startsWith('http') ? line : new URL(line, `https://hlsx3cdn.echovideo.to/${slug}/${episode}/master.m3u8`).href });
        meta = {};
      }
    }

    res.json({
      success: true,
      slug,
      episode:     parseInt(episode, 10),
      episodeId:   `${slug}/episode/${episode}`,
      anilistId,                              // ← auto-resolved, null if not found
      source:      `https://hlsx3cdn.echovideo.to/${slug}/${episode}/master.m3u8`,
      streamCount: streams.length,
      streams,
    });
  } catch (err) {
    res.status(500).json({ success: false, slug, episode, error: err.message });
  }
});

// GET /anime/123animes/recent/:type?page=N
router.get('/recent/:type', async (req, res) => {
  const { type } = req.params;
  const page     = Math.max(1, parseInt(req.query.page, 10) || 1);

  if (!RECENT_PATHS[type]) {
    return res.status(400).json({
      success: false,
      error: `Unknown type "${type}". Valid: subbed-anime, dubbed-anime, chinese-anime`,
    });
  }

  const cacheKey = `recent_${type}_p${page}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return res.json({ success: true, cached: true, ...cached });

  try {
    const result = await scrapeRecentPage(type, page);
    cacheSet(cacheKey, result, 10 * 60 * 1000);
    res.json({ success: true, cached: false, ...result });
  } catch (err) {
    console.error(`[123animes recent/${type}] error:`, err.message);
    res.status(500).json({ success: false, type, page, error: err.message });
  }
});

// GET /anime/123animes/debug/:anilistId
router.get('/debug/:anilistId', async (req, res) => {
  const { anilistId } = req.params;
  try {
    const media = await fetchAnilistMedia(anilistId);
    if (!media) return res.status(404).json({ error: 'AniList ID not found' });

    const allTitles = [
      media.title?.english, media.title?.romaji,
      media.title?.native, ...(media.synonyms || []),
    ].filter(Boolean);

    const asciiTitles = allTitles.filter(t => !/[^\x00-\x7F]/.test(t));
    const slugsToTry  = [...new Set(asciiTitles.flatMap(slugVariations))];

    const slugChecks = await Promise.all(
      slugsToTry.map(async (slug) => ({
        slug,
        exists: await checkSlugExists(slug),
        url: `${BASE}/anime/${slug}`,
      }))
    );

    res.json({
      anilistId,
      titles: { english: media.title?.english, romaji: media.title?.romaji },
      asciiTitles,
      slugChecks,
      hits: slugChecks.filter(s => s.exists),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;