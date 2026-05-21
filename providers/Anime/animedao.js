import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';
import {
  extractExternalIds,
  mapAnilistMedia,
  fetchAnilistMedia,
  resolveTMDB,
} from '../Anime/meta/graphqltmbd.js';

const router = express.Router();

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://vibeplayer.site',
  Referer: 'https://vibeplayer.site/',
};

const BASE_URL = 'https://anidao.to';

// Per-router cache: watchSlug → real animedao watchUrl
const watchUrlCache = new Map();

// ── PAGE FETCHER ──────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await gotScraping({
    url,
    followRedirect: true,
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 120 }],
      devices: ['desktop'],
      locales: ['en-US'],
      operatingSystems: ['windows'],
    },
  });
  return res.body;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getSlugCandidates(watchSlug) {
  const candidates = [watchSlug];
  const slugMatch = watchSlug.match(/^(.+)-episode-(\d+)$/);
  if (!slugMatch) return candidates;

  const animeSlug = slugMatch[1];
  const epNum = slugMatch[2];

  const stripped = animeSlug.replace(/-\d+$/, '');
  if (stripped !== animeSlug) {
    candidates.push(`${stripped}-episode-${epNum}`);
  }

  return candidates;
}

function toAbsolute(url, baseDir) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return new URL(baseDir).origin + url;
  return baseDir + url;
}

function rewriteM3u8(content, originalUrl, proxyBase, apiKey) {
  const base = new URL(originalUrl);
  const baseDir = base.origin + base.pathname.replace(/\/[^/]*$/, '/');
  const keyParam = apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : '';

  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const absolute = toAbsolute(uri, baseDir);
          return `URI="${proxyBase}/anime/animedao/proxy/segment?url=${encodeURIComponent(absolute)}${keyParam}"`;
        });
      }

      const absolute = toAbsolute(trimmed, baseDir);

      if (/\.m3u8(\?|$)/.test(absolute)) {
        return `${proxyBase}/anime/animedao/proxy/m3u8?url=${encodeURIComponent(absolute)}${keyParam}`;
      }
      return `${proxyBase}/anime/animedao/proxy/segment?url=${encodeURIComponent(absolute)}${keyParam}`;
    })
    .join('\n');
}

function resolveM3u8(hash) {
  if (/^[a-f0-9]{16}$/.test(hash)) {
    return `https://vibeplayer.site/public/stream/${hash}/master.m3u8`;
  }
  if (/^ag[a-zA-Z0-9]+h$/.test(hash)) {
    return `https://file.takutakucdn.store/${hash}/master.m3u8`;
  }
  return null;
}

/**
 * Extracts vibeplayer hashes from raw HTML using regex.
 * The site no longer uses ul.server-items / data-video attributes —
 * hashes are now embedded directly in the page HTML/JS.
 *
 * Strategy:
 *   1. Find every vibeplayer hash in the HTML with up to 300 chars of
 *      preceding context so we can guess SUB / DUB / HSUB.
 *   2. De-duplicate hashes (same hash may appear in multiple script blocks).
 *   3. Group by detected category; unknown → "sub" as safe default.
 */
function extractByCategory(rawHtml) {
  const HASH_RE = /vibeplayer\.site\/((?:[a-f0-9]{16})|(?:ag[a-zA-Z0-9]+h))(?:[?&]sub=([^\s"'<>&]+))?/g;

  const seen = new Set();
  // category → [ { hash, subUrl, serverName } ]
  const buckets = {};

  let match;
  while ((match = HASH_RE.exec(rawHtml)) !== null) {
    const hash   = match[1];
    const subUrl = match[2] || null;

    if (seen.has(hash)) continue;
    seen.add(hash);

    const m3u8 = resolveM3u8(hash);
    if (!m3u8) continue;

    // Grab up to 400 chars before the match to find a category label
    const before = rawHtml.slice(Math.max(0, match.index - 400), match.index).toLowerCase();

    let category = 'sub'; // default
    // Look for explicit category keywords nearest to the hash
    const dubIdx  = before.lastIndexOf('dub');
    const subIdx  = before.lastIndexOf('sub');
    const hsubIdx = before.lastIndexOf('hsub');
    const rawIdx  = before.lastIndexOf('raw');

    const best = Math.max(dubIdx, subIdx, hsubIdx, rawIdx);
    if (best !== -1) {
      if (best === hsubIdx)     category = 'hsub';
      else if (best === dubIdx) category = 'dub';
      else if (best === rawIdx) category = 'raw';
      else                      category = 'sub';
    }

    // Try to find a server name near the hash (text inside quotes near the match)
    const serverMatch = rawHtml.slice(match.index - 100, match.index + 100).match(/["'>]([A-Za-z0-9 _-]{2,20})["'<]/);
    const serverName  = serverMatch ? serverMatch[1].trim() : `Server ${seen.size}`;

    if (!buckets[category]) buckets[category] = [];
    buckets[category].push({ server: serverName, hash, subUrl, m3u8 });
  }

  // Convert to the shape the rest of the code expects
  const categories = {};
  for (const [cat, entries] of Object.entries(buckets)) {
    categories[cat] = entries.map((e) => ({
      server:   e.server,
      hash:     e.hash,
      embed:    `https://vibeplayer.site/${e.hash}`,
      m3u8:     e.m3u8,
      subtitle: e.subUrl,
    }));
  }

  return categories;
}

/** Returns true if the HTML contains at least one vibeplayer hash */
function hasVibeStreams(html) {
  return /vibeplayer\.site\/(?:[a-f0-9]{16}|ag[a-zA-Z0-9]+h)/.test(html);
}

async function getAllQualities(masterUrl) {
  try {
    const response = await axios.get(masterUrl, { headers: HEADERS });
    const lines = response.data.split('\n');
    const baseDir = masterUrl.replace(/\/[^/]*$/, '/');
    const qualities = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

      const nextLine = (lines[i + 1] || '').trim();
      if (!nextLine || nextLine.startsWith('#')) continue;

      const resMatch  = line.match(/RESOLUTION=(\d+x\d+)/);
      const bwMatch   = line.match(/BANDWIDTH=(\d+)/);
      const nameMatch = line.match(/NAME="?([^",]+)"?/);

      const resolution = resMatch ? resMatch[1] : null;
      const bandwidth  = bwMatch ? parseInt(bwMatch[1]) : 0;
      const height     = resolution ? parseInt(resolution.split('x')[1]) : 0;
      const label      = nameMatch ? nameMatch[1] : height ? `${height}p` : `${bandwidth}bps`;

      qualities.push({ label, resolution, bandwidth, height, original: toAbsolute(nextLine, baseDir) });
      i++;
    }

    return qualities.sort((a, b) => b.height - a.height);
  } catch (err) {
    console.error(`[animedao] getAllQualities failed [${masterUrl}]:`, err.message);
    return [];
  }
}

async function buildStreamEntry(s, proxyBase, apiKey) {
  const keyParam   = apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : '';
  const qualities  = await getAllQualities(s.m3u8);
  const proxiedM3u8 = `${proxyBase}/anime/animedao/proxy/m3u8?url=${encodeURIComponent(s.m3u8)}${keyParam}`;

  const playerBase = `${proxyBase}/anime/animedao/player?url=${encodeURIComponent(proxiedM3u8)}`;
  const player     = s.subtitle ? `${playerBase}&sub=${encodeURIComponent(s.subtitle)}` : playerBase;

  return {
    server:      s.server,
    hash:        s.hash,
    player,
    proxiedM3u8,
    original:    s.m3u8,
    subtitle:    s.subtitle,
    qualities: qualities.map((q) => {
      const proxied  = `${proxyBase}/anime/animedao/proxy/m3u8?url=${encodeURIComponent(q.original)}${keyParam}`;
      const pBase    = `${proxyBase}/anime/animedao/player?url=${encodeURIComponent(proxied)}`;
      const pPlayer  = s.subtitle ? `${pBase}&sub=${encodeURIComponent(s.subtitle)}` : pBase;
      return { label: q.label, resolution: q.resolution, bandwidth: q.bandwidth, original: q.original, proxied, player: pPlayer };
    }),
  };
}

function getProxyBase(req) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0].trim() || req.protocol;
  return `${proto}://${req.get('host')}`;
}

// ── ANILIST + TMDB HELPERS ────────────────────────────────────────────────────

function toAnimeSlug(title) {
  return title
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function resolveAnimeDAOEpisodes(media, proxyBase) {
  const titles = [
    media.title?.english,
    media.title?.romaji,
    ...(media.synonyms || []),
  ].filter(Boolean);

  const slugCandidates = [...new Set(titles.map(toAnimeSlug))];

  for (const slug of slugCandidates) {
    const url = `${BASE_URL}/anime/${slug}`;
    console.log(`[animedao/details] trying slug → ${slug}`);
    try {
      const html = await fetchPage(url);
      const $    = cheerio.load(html);
        if ($('article.an-episode-row').length === 0) continue;

      const episodes = [];

      $('article.an-episode-row').each((_, el) => {
        const link     = $(el).find('a.an-episode-row__thumb').attr('href')
                      || $(el).find('a.an-play-btn').attr('href')
                      || null;
        const watchUrl = link ? (link.startsWith('http') ? link : `${BASE_URL}${link}`) : null;

        const watchSlug = watchUrl ? watchUrl.split('/watch-online/')[1] : null;
        const slugMatch = watchSlug?.match(/^(.+)-episode-(\d+)$/);
        const epNum     = slugMatch ? parseInt(slugMatch[2]) : null;

        const titleRaw  = $(el).find('.an-episode-row__title a').text().trim()
                       || (epNum != null ? `Episode ${epNum}` : '');
        const epTitle   = titleRaw;

        const metaSpans = $(el).find('.an-episode-row__meta span');
        const dateRaw   = metaSpans.first().text().trim().replace(/\s+/g, ' ').trim();

        const streamUrl = watchSlug ? `${proxyBase}/anime/animedao/source/${watchSlug}` : null;

        if (watchSlug && watchUrl) watchUrlCache.set(watchSlug, watchUrl);

        if (watchSlug) {
          episodes.push({ id: watchSlug, episodeId: watchSlug, episode: epNum, title: epTitle, fullTitle: titleRaw, date: dateRaw, watchUrl, streamUrl });
        }
      });

      if (episodes.length === 0) continue;

      episodes.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
      console.log(`[animedao/details] ✓ found ${episodes.length} episodes with slug "${slug}"`);
      return { slug, episodes };
    } catch (err) {
      console.log(`[animedao/details] slug "${slug}" failed: ${err.message}`);
    }
  }

  return null;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/anime/animedao`;
  res.json({
    provider: 'animedao',
    source: 'https://anidao.to',
    endpoints: [
      { method: 'GET', path: '/anime/animedao/recent',              description: 'Latest episode updates from the homepage',                        example: `${base}/recent` },
          { method: 'GET', path: '/anime/animedao/recent?tab=sub',              description: 'Latest episode updates from the homepage',                        example: `${base}/recent` },
      { method: 'GET', path: ' /anime/animedao/recent?tab=dub',              description: 'Latest episode updates from the homepage',                        example: `${base}/recent` },
      { method: 'GET', path: '/anime/animedao/recent?tab=popular',              description: 'Latest episode updates from the homepage',                        example: `${base}/recent` },
      { method: 'GET', path: '/anime/animedao/recent?tab=chinese',              description: 'Latest episode updates from the homepage',                        example: `${base}/recent` },

      { method: 'GET', path: '/anime/animedao/episodes/:animeSlug', description: 'All episodes for a given anime slug',                             example: `${base}/episodes/one-piece` },
      { method: 'GET', path: '/anime/animedao/source/:watchSlug',   description: 'Stream sources (SUB / DUB / HSUB) for an episode',               example: `${base}/source/one-piece-episode-2` },
      { method: 'GET', path: '/anime/animedao/details/:anilistId',  description: 'Full AniList + TMDB metadata merged with AnimeDAO episode list', example: `${base}/details/21` },
      { method: 'GET', path: '/anime/animedao/proxy/m3u8',          description: 'Rewrites and proxies an m3u8 playlist',                          example: `${base}/proxy/m3u8?url=<m3u8-url>` },
      { method: 'GET', path: '/anime/animedao/proxy/segment',       description: 'Proxies raw media segments (.ts, keys)',                         example: `${base}/proxy/segment?url=<segment-url>` },
      { method: 'GET', path: '/anime/animedao/player',              description: 'Built-in HLS player with quality selector and optional subtitles', example: `${base}/player?url=<proxied-m3u8-url>&sub=<vtt-url>` },
    ],
  });
});

/**
 * GET /anime/animedao/recent
 */
router.get('/recent', async (req, res) => {
  const { tab = 'all', apiKey } = req.query;
  const VALID_TABS = ['all', 'sub', 'dub', 'popular', 'chinese'];

  if (!VALID_TABS.includes(tab)) {
    return res.status(400).json({
      error: `Invalid tab. Must be one of: ${VALID_TABS.join(', ')}`,
    });
  }

  try {
    const html      = await fetchPage(`${BASE_URL}/`);
    const $         = cheerio.load(html);
    const recent    = [];
    const proxyBase = getProxyBase(req);

    // Scope to the correct tab panel — all panels are pre-rendered in the HTML
    const panel = $(`div.an-tab-panel[data-an-panel="${tab}"]`);

    panel.find('article.an-anime-card').each((_, el) => {
      const watchPath = $(el).find("a[href*='/watch-online/']").first().attr('href') || null;
      const watchUrl  = watchPath ? `${BASE_URL}${watchPath}` : null;
      const watchSlug = watchPath ? watchPath.split('/watch-online/')[1] : null;

      const animeSlug = watchSlug?.match(/^(.+)-episode-\d+$/)?.[1] || null;
      const animeUrl  = animeSlug ? `${BASE_URL}/anime/${animeSlug}` : null;

      const rawTitle  = $(el).find('.an-anime-card__title a').text().trim();
      const epText    = $(el).find('.an-anime-card__meta span').first().text().trim();
      const epNum     = epText ? parseInt(epText.replace(/\D/g, ''), 10) || null : null;

      const thumbnail = $(el).find('img').attr('src') || null;
      const date      = $(el).find('.an-anime-card__time').text().trim();
      const isHot     = $(el).find('.an-badge--hot').length > 0;
      const streamUrl = watchSlug ? `${proxyBase}/anime/animedao/source/${watchSlug}` : null;

      // Sub/dub episode counts from the badge pills
      const subEp  = parseInt($(el).find('.an-episode-pill--sub').text().replace(/\D/g, '')) || null;
      const dubEp  = parseInt($(el).find('.an-episode-pill--dub').text().replace(/\D/g, '')) || null;

      if (watchSlug) watchUrlCache.set(watchSlug, watchUrl);

      if (watchSlug) {
        recent.push({
          episodeId:  watchSlug,
          animeTitle: rawTitle,
          episode:    epNum,
          subEpisode: subEp,
          dubEpisode: dubEp,
          isHot,
          thumbnail,
          date,
          watchUrl,
          animeUrl,
          animeSlug,
          streamUrl,
        });
      }
    });

    res.json({
      tab,
      tabs: VALID_TABS,
      total: recent.length,
      recent,
    });
  } catch (err) {
    res.status(500).json({ error: 'Page fetch failed: ' + err.message });
  }
});

/**
 * GET /anime/animedao/episodes/:animeSlug
 */
router.get('/episodes/:animeSlug', async (req, res) => {
  const { animeSlug } = req.params;
  const url = `${BASE_URL}/anime/${animeSlug}`;

  try {
    const html      = await fetchPage(url);
    const $         = cheerio.load(html);
    const episodes  = [];
    const proxyBase = getProxyBase(req);

   $('article.an-episode-row').each((_, el) => {
      const link     = $(el).find('a.an-episode-row__thumb').attr('href')
                    || $(el).find('a.an-play-btn').attr('href')
                    || null;
      const watchUrl = link ? (link.startsWith('http') ? link : `${BASE_URL}${link}`) : null;

      const watchSlug = watchUrl ? watchUrl.split('/watch-online/')[1] : null;
      const slugMatch = watchSlug ? watchSlug.match(/^(.+)-episode-(\d+)$/) : null;
      const epNum     = slugMatch ? parseInt(slugMatch[2]) : null;

      const titleRaw  = $(el).find('.an-episode-row__title a').text().trim()
                     || (epNum != null ? `Episode ${epNum}` : '');
      const epTitle   = titleRaw;

      const metaSpans = $(el).find('.an-episode-row__meta span');
      const dateRaw   = metaSpans.first().text().trim();
      const date      = dateRaw.replace(/\s+/g, ' ').trim();

      const streamUrl = watchSlug ? `${proxyBase}/anime/animedao/source/${watchSlug}` : null;

      if (watchSlug && watchUrl) watchUrlCache.set(watchSlug, watchUrl);

      if (watchSlug) {
        episodes.push({ id: watchSlug, episodeId: watchSlug, episode: epNum, title: epTitle, fullTitle: titleRaw, date, watchUrl, streamUrl });
      }
    });

    episodes.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    res.json({ total: episodes.length, episodes });
  } catch (err) {
    res.status(500).json({ error: 'Page fetch failed: ' + err.message });
  }
});

/**
 * GET /anime/animedao/source/:watchSlug
 */
router.get('/source/:watchSlug', async (req, res) => {
  const { watchSlug } = req.params;
  const apiKey = req.query.apiKey;

  const candidates = [
    watchUrlCache.get(watchSlug),
    ...getSlugCandidates(watchSlug).map((s) => `${BASE_URL}/watch-online/${s}`),
  ].filter(Boolean);

  const uniqueCandidates = [...new Set(candidates)];

  const slugMatch = watchSlug.match(/^(.+)-episode-(\d+)$/);
  const animeSlug = slugMatch ? slugMatch[1] : watchSlug;
  const epNum     = slugMatch ? parseInt(slugMatch[2]) : null;

  let rawHtml  = null;
  let usedUrl  = null;

  for (const watchUrl of uniqueCandidates) {
    console.log(`[animedao] trying → ${watchUrl}`);
    try {
      const html = await fetchPage(watchUrl);

      if (html.includes('Pages not found')) {
        console.log(`[animedao] 404 page → skipping`);
        continue;
      }

      // ✅ Check for old-style selectors OR new-style inline vibe hashes
      const $              = cheerio.load(html);
      const hasServerItems = $('ul.server-items').length > 0;
      const hasDataVideo   = $('[data-video]').length > 0;
      const hasVibeHash    = hasVibeStreams(html);

      console.log(`[animedao] ${watchUrl} → serverItems:${hasServerItems} dataVideo:${hasDataVideo} vibeHash:${hasVibeHash}`);

      if (hasServerItems || hasDataVideo || hasVibeHash) {
        rawHtml  = html;
        usedUrl  = watchUrl;
        console.log(`[animedao] ✓ found streams at ${watchUrl}`);
        break;
      }
    } catch (err) {
      console.log(`[animedao] error fetching ${watchUrl}: ${err.message}`);
    }
  }

  if (!rawHtml) {
    return res.status(404).json({
      error: 'No streams found — all slug candidates returned 404 or empty',
      tried: uniqueCandidates,
    });
  }

  const categories = extractByCategory(rawHtml);

  if (!Object.keys(categories).length) {
    return res.status(404).json({
      error: 'Page found but no vibeplayer streams could be parsed',
      usedUrl,
    });
  }

  const proxyBase = getProxyBase(req);

  const result = {
    id:        watchSlug,
    episodeId: epNum != null ? `episode-${epNum}` : null,
    episode:   epNum,
    animeSlug,
    watchUrl:  usedUrl,
  };

  await Promise.all(
    Object.entries(categories).map(async ([cat, servers]) => {
      result[cat] = await Promise.all(servers.map((s) => buildStreamEntry(s, proxyBase, apiKey)));
    })
  );

  res.json(result);
});

/**
 * GET /anime/animedao/details/:anilistId
 */
router.get('/details/:anilistId', async (req, res) => {
  const anilistId = parseInt(req.params.anilistId, 10);
  if (isNaN(anilistId)) return res.status(400).json({ error: 'Invalid AniList ID — must be a number' });

  const proxyBase = getProxyBase(req);

  let rawMedia;
  try {
    rawMedia = await fetchAnilistMedia(anilistId);
  } catch (err) {
    return res.status(502).json({ error: 'AniList fetch failed: ' + err.message });
  }
  if (!rawMedia) return res.status(404).json({ error: `No AniList media found for ID ${anilistId}` });

  const media = mapAnilistMedia(rawMedia);

  const [tmdbResult, episodeResult] = await Promise.all([
    resolveTMDB(rawMedia).catch((err) => {
      console.warn('[animedao/details] TMDB resolution failed:', err.message);
      return { tmdbId: null, tmdbInfo: null, tmdbLookup: new Map() };
    }),
    resolveAnimeDAOEpisodes(rawMedia, proxyBase),
  ]);

  const { tmdbId, tmdbInfo, tmdbLookup } = tmdbResult;

  const episodes = (episodeResult?.episodes || []).map((ep) => {
    const tmdbEp = ep.episode != null ? tmdbLookup.get(ep.episode) : undefined;
    return {
      id:            ep.id,
      episodeId:     ep.episodeId,
      episode:       ep.episode,
      title:         ep.title,
      fullTitle:     ep.fullTitle,
      date:          ep.date,
      watchUrl:      ep.watchUrl,
      streamUrl:     ep.streamUrl,
      tmdbTitle:     tmdbEp?.title         || null,
      overview:      tmdbEp?.overview      || null,
      airDate:       tmdbEp?.airDate       || null,
      aired:         tmdbEp?.aired         ?? null,
      tmdbRating:    tmdbEp?.rating        || null,
      thumbnail:     tmdbEp?.thumbnail     || null,
      seasonNumber:  tmdbEp?.seasonNumber  ?? null,
      episodeNumber: tmdbEp?.episodeNumber ?? null,
    };
  });

  res.json({
    id:              media.id,
    title:           media.title,
    description:     media.description,
    image:           media.image,
    cover:           media.cover,
    rating:          media.rating,
    status:          media.status,
    type:            media.type,
    genres:          media.genres,
    studios:         media.studios,
    duration:        media.duration,
    releaseDate:     media.releaseDate,
    trailer:         media.trailer,
    externalIds:     media.externalIds,
    externalLinks:   media.externalLinks,
    characters:      media.characters,
    recommendations: media.recommendations,
    relations:       media.relations,
    tmdbId,
    tmdb: tmdbInfo ? {
      name:          tmdbInfo.name,
      overview:      tmdbInfo.overview,
      firstAirDate:  tmdbInfo.firstAirDate,
      totalSeasons:  tmdbInfo.totalSeasons,
      totalEpisodes: tmdbInfo.totalEpisodes,
      posterPath:    tmdbInfo.posterPath,
      backdropPath:  tmdbInfo.backdropPath,
      genres:        tmdbInfo.genres,
      rating:        tmdbInfo.rating,
      seasons:       tmdbInfo.seasons,
    } : null,
    animeDAOSlug:  episodeResult?.slug  || null,
    totalEpisodes: episodes.length      || media.totalEpisodes || null,
    episodes,
  });
});

/**
 * GET /anime/animedao/proxy/m3u8
 */
router.get('/proxy/m3u8', async (req, res) => {
  const { url, apiKey } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  const proxyBase = getProxyBase(req);

  try {
    const response  = await axios.get(url, { headers: HEADERS, responseType: 'text' });
    const rewritten = rewriteM3u8(response.data, url, proxyBase, apiKey);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch (err) {
    res.status(502).send('Failed to fetch m3u8: ' + err.message);
  }
});

/**
 * GET /anime/animedao/proxy/segment
 */
router.get('/proxy/segment', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  try {
    const response = await axios.get(url, { headers: HEADERS, responseType: 'stream' });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
    res.setHeader('Cache-Control', 'max-age=3600');
    response.data.pipe(res);
  } catch (err) {
    console.error('[animedao] segment proxy error:', err.message);
    res.status(502).send('Failed to fetch segment: ' + err.message);
  }
});

// ── CORS MIDDLEWARE ───────────────────────────────────────────────────────────

router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

/**
 * GET /anime/animedao/player
 */
router.get('/player', (req, res) => {
  const { url, sub, apiKey } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  const m3u8Url  = apiKey ? `${url}&apiKey=${encodeURIComponent(apiKey)}` : url;
  const subTrack = sub ? `<track kind="subtitles" src="${sub}" srclang="en" label="English" default>` : '';

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AnimeDAO Player</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; gap: 10px; }
    video { width: 100%; max-width: 1280px; max-height: 90vh; }
    #controls { display: flex; gap: 8px; align-items: center; }
    #qualitySelect { background: #222; color: #fff; border: 1px solid #555; padding: 6px 12px; border-radius: 4px; font-size: 14px; cursor: pointer; }
    #qualitySelect:hover { border-color: #fff; }
    #qualityLabel { color: #aaa; font-size: 13px; font-family: sans-serif; }
  </style>
</head>
<body>
  <video id="video" controls autoplay crossorigin="anonymous">${subTrack}</video>
  <div id="controls">
    <span id="qualityLabel">Quality:</span>
    <select id="qualitySelect"><option value="-1">Auto</option></select>
  </div>
  <script>
    const src   = decodeURIComponent("${encodeURIComponent(m3u8Url)}");
    const video = document.getElementById("video");
    const sel   = document.getElementById("qualitySelect");

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        video.play();
        data.levels.forEach((level, i) => {
          const opt = document.createElement("option");
          opt.value = i;
          opt.text  = level.height ? level.height + "p" : "Level " + i;
          sel.appendChild(opt);
        });
      });
      sel.addEventListener("change", () => { hls.currentLevel = parseInt(sel.value); });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => { if (hls.autoLevelEnabled) sel.value = -1; });
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) console.error("HLS fatal error:", data.type, data.details); });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.play();
      document.getElementById("controls").style.display = "none";
    } else {
      document.body.innerHTML = '<p style="color:red;padding:20px;font-family:sans-serif">HLS not supported in this browser.</p>';
    }
  </script>
</body>
</html>`);
});

export default router;