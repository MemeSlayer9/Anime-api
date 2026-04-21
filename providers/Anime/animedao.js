import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
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

const PAGE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://google.com',
};

const BASE_URL = 'https://animedao.ac';

// Per-router cache: watchSlug → real animedao watchUrl
const watchUrlCache = new Map();

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getSlugCandidates(watchSlug) {
  const candidates = [watchSlug];
  const slugMatch = watchSlug.match(/^(.+)-episode-(\d+)$/);
  if (!slugMatch) return candidates;

  const animeSlug = slugMatch[1];
  const epNum = slugMatch[2];

  // Strip trailing -NNN: "one-piece-100" → "one-piece"
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

function rewriteM3u8(content, originalUrl, proxyBase) {
  const base = new URL(originalUrl);
  const baseDir = base.origin + base.pathname.replace(/\/[^/]*$/, '/');

  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const absolute = toAbsolute(uri, baseDir);
          return `URI="${proxyBase}/anime/animedao/proxy/segment?url=${encodeURIComponent(absolute)}"`;
        });
      }

      const absolute = toAbsolute(trimmed, baseDir);

      if (/\.m3u8(\?|$)/.test(absolute)) {
        return `${proxyBase}/anime/animedao/proxy/m3u8?url=${encodeURIComponent(absolute)}`;
      }
      return `${proxyBase}/anime/animedao/proxy/segment?url=${encodeURIComponent(absolute)}`;
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

function extractByCategory(rawHtml) {
  const $ = cheerio.load(rawHtml);
  const categories = {};

  $('ul.server-items').each((_, ul) => {
    const labelRaw = $(ul).find('li:first-child strong').text().trim();
    const label = labelRaw.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (!label) return;

    const servers = [];

    $(ul)
      .find('li.server a[data-video]')
      .each((_, a) => {
        const dataVideo = $(a).attr('data-video') || '';
        const serverName = $(a).text().trim();

        const vibeMatch = dataVideo.match(
          /vibeplayer\.site\/((?:[a-f0-9]{16})|(?:ag[a-zA-Z0-9]+h))(?:\?sub=([^\s"'<>&]+))?/
        );
        if (!vibeMatch) return;

        const hash = vibeMatch[1];
        const subUrl = vibeMatch[2] || null;
        const m3u8 = resolveM3u8(hash);
        if (!m3u8) return;

        servers.push({
          server: serverName,
          hash,
          embed: `https://vibeplayer.site/${hash}`,
          m3u8,
          subtitle: subUrl,
        });
      });

    if (servers.length) categories[label] = servers;
  });

  return categories;
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

      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const nameMatch = line.match(/NAME="?([^",]+)"?/);

      const resolution = resMatch ? resMatch[1] : null;
      const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
      const height = resolution ? parseInt(resolution.split('x')[1]) : 0;
      const label = nameMatch ? nameMatch[1] : height ? `${height}p` : `${bandwidth}bps`;

      qualities.push({
        label,
        resolution,
        bandwidth,
        height,
        original: toAbsolute(nextLine, baseDir),
      });
      i++;
    }

    return qualities.sort((a, b) => b.height - a.height);
  } catch (err) {
    console.error(`[animedao] getAllQualities failed [${masterUrl}]:`, err.message);
    return [];
  }
}

async function buildStreamEntry(s, proxyBase) {
  const qualities = await getAllQualities(s.m3u8);
  const proxiedM3u8 = `${proxyBase}/anime/animedao/proxy/m3u8?url=${encodeURIComponent(s.m3u8)}`;
  const playerBase = `${proxyBase}/anime/animedao/player?url=${proxiedM3u8}`;
  const player = s.subtitle ? `${playerBase}&sub=${encodeURIComponent(s.subtitle)}` : playerBase;

  return {
    server: s.server,
    hash: s.hash,
    player,
    proxiedM3u8,
    original: s.m3u8,
    subtitle: s.subtitle,
    qualities: qualities.map((q) => {
      const proxied = `${proxyBase}/anime/animedao/proxy/m3u8?url=${encodeURIComponent(q.original)}`;
      const pBase = `${proxyBase}/anime/animedao/player?url=${proxied}`;
      const pPlayer = s.subtitle ? `${pBase}&sub=${encodeURIComponent(s.subtitle)}` : pBase;
      return {
        label: q.label,
        resolution: q.resolution,
        bandwidth: q.bandwidth,
        original: q.original,
        proxied,
        player: pPlayer,
      };
    }),
  };
}

// ── NEW HELPERS (AniList + TMDB integration) ──────────────────────────────────

/**
 * Converts an anime title into a URL-safe animedao slug.
 * "One Piece"  → "one-piece"
 * "Re:ZERO"    → "rezero"
 * "Sword Art Online: Alicization" → "sword-art-online-alicization"
 */
function toAnimeSlug(title) {
  return title
    .toLowerCase()
    .replace(/['']/g, '')           // drop apostrophes / curly quotes
    .replace(/[^a-z0-9]+/g, '-')   // non-alphanum → dash
    .replace(/^-+|-+$/g, '');      // trim leading/trailing dashes
}

/**
 * Tries to fetch and parse the animedao episode list for several slug
 * candidates derived from an AniList media object's titles and synonyms.
 * Returns { slug, episodes } on the first successful hit, or null.
 */
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
      const response = await axios.get(url, { headers: PAGE_HEADERS, maxRedirects: 5 });
      const $ = cheerio.load(response.data);
      if ($('.episode_well').length === 0) continue;

      const episodes = [];

      $('.episode_well').each((_, el) => {
        const titleRaw = $(el).find('.anime-title').text().trim();
        const dateRaw  = $(el).find('.front_time').text().trim().replace(/\s+/g, ' ').trim();

        const link     = $(el).closest('a').attr('href') || $(el).find('a').attr('href') || null;
        const watchUrl = link
          ? link.startsWith('http') ? link : `${BASE_URL}${link}`
          : null;

        const watchSlug = watchUrl ? watchUrl.split('/watch-online/')[1] : null;
        const slugMatch = watchSlug?.match(/^(.+)-episode-(\d+)$/);
        const epNum     = slugMatch ? parseInt(slugMatch[2]) : null;

        const colonIdx = titleRaw.indexOf(':');
        const epTitle  = colonIdx !== -1 ? titleRaw.slice(colonIdx + 1).trim() : titleRaw;

        const streamUrl = watchSlug
          ? `${proxyBase}/anime/animedao/source/${watchSlug}`
          : null;

        if (watchSlug && watchUrl) watchUrlCache.set(watchSlug, watchUrl);

        if (titleRaw) {
          episodes.push({
            id:        watchSlug,
            episodeId: watchSlug,
            episode:   epNum,
            title:     epTitle,
            fullTitle: titleRaw,
            date:      dateRaw,
            watchUrl,
            streamUrl,
          });
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

/**
 * GET /anime/animedao
 * Provider info and endpoint reference with examples.
 */
router.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/anime/animedao`;
  res.json({
    provider: 'animedao',
    source: 'https://animedao.ac',
    endpoints: [
      {
        method: 'GET',
        path: '/anime/animedao/recent',
        description: 'Latest episode updates from the homepage',
        example: `${base}/recent`,
      },
      {
        method: 'GET',
        path: '/anime/animedao/episodes/:animeSlug',
        description: 'All episodes for a given anime slug',
        example: `${base}/episodes/one-piece`,
      },
      {
        method: 'GET',
        path: '/anime/animedao/source/:watchSlug',
        description: 'Stream sources (SUB / DUB / HSUB) for an episode',
        example: `${base}/source/one-piece-episode-2`,
      },
      {
        method: 'GET',
        path: '/anime/animedao/details/:anilistId',
        description: 'Full AniList + TMDB metadata merged with AnimeDAO episode list',
        example: `${base}/details/21`,
      },
      {
        method: 'GET',
        path: '/anime/animedao/proxy/m3u8',
        description: 'Rewrites and proxies an m3u8 playlist',
        example: `${base}/proxy/m3u8?url=<m3u8-url>`,
      },
      {
        method: 'GET',
        path: '/anime/animedao/proxy/segment',
        description: 'Proxies raw media segments (.ts, keys)',
        example: `${base}/proxy/segment?url=<segment-url>`,
      },
      {
        method: 'GET',
        path: '/anime/animedao/player',
        description: 'Built-in HLS player with quality selector and optional subtitles',
        example: `${base}/player?url=<proxied-m3u8-url>&sub=<vtt-url>`,
      },
    ],
  });
});

/**
 * GET /anime/animedao/recent
 * Returns recently updated episodes from animedao homepage.
 */
router.get('/recent', async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/`, { headers: PAGE_HEADERS, maxRedirects: 5 });
    const $ = cheerio.load(response.data);
    const recent = [];

    $('.well').each((_, el) => {
      const watchPath = $(el).find("a[href*='/watch-online/']").first().attr('href') || null;
      const watchUrl = watchPath ? `${BASE_URL}${watchPath}` : null;
      const watchSlug = watchPath ? watchPath.split('/watch-online/')[1] : null;

      const animePath = $(el).find('a.latest-parent').attr('href') || null;
      const animeUrl = animePath ? `${BASE_URL}${animePath}` : null;
      const animeSlug = animePath ? animePath.split('/anime/')[1] : null;

      const rawTitle = $(el).find('.latestanime-title a').text().trim();
      const titleMatch = rawTitle.match(/^(.+?)\s*\(\s*Episode\s*(\d+)\s*\)$/i);
      const animeTitle = titleMatch ? titleMatch[1].trim() : rawTitle;
      const epNum = titleMatch ? parseInt(titleMatch[2]) : null;

      const thumbnail = $(el).find('img').attr('src') || null;
      const date = $(el).find('.front_time').text().trim().replace(/\s+/g, ' ');

      const proxyBase = `${req.protocol}://${req.get('host')}`;
      const streamUrl = watchSlug
        ? `${proxyBase}/anime/animedao/source/${watchSlug}`
        : null;

      if (watchSlug) watchUrlCache.set(watchSlug, watchUrl);

      if (watchSlug) {
        recent.push({
          episodeId: watchSlug,
          animeTitle,
          episode: epNum,
          thumbnail,
          date,
          watchUrl,
          animeUrl,
          animeSlug,
          streamUrl,
        });
      }
    });

    res.json({ total: recent.length, recent });
  } catch (err) {
    res.status(500).json({ error: 'Page fetch failed: ' + err.message });
  }
});

/**
 * GET /anime/animedao/episodes/:animeSlug
 * Returns all episodes for a given anime slug.
 * Example: /anime/animedao/episodes/one-piece
 */
router.get('/episodes/:animeSlug', async (req, res) => {
  const { animeSlug } = req.params;
  const url = `${BASE_URL}/anime/${animeSlug}`;

  try {
    const response = await axios.get(url, { headers: PAGE_HEADERS, maxRedirects: 5 });
    const $ = cheerio.load(response.data);
    const episodes = [];

    $('.episode_well').each((_, el) => {
      const titleRaw = $(el).find('.anime-title').text().trim();
      const dateRaw = $(el).find('.front_time').text().trim();
      const date = dateRaw.replace(/\s+/g, ' ').trim();

      const link = $(el).closest('a').attr('href') || $(el).find('a').attr('href') || null;
      const watchUrl = link
        ? link.startsWith('http')
          ? link
          : `${BASE_URL}${link}`
        : null;

      const watchSlug = watchUrl ? watchUrl.split('/watch-online/')[1] : null;
      const slugMatch = watchSlug ? watchSlug.match(/^(.+)-episode-(\d+)$/) : null;
      const epNum = slugMatch ? parseInt(slugMatch[2]) : null;

      const colonIdx = titleRaw.indexOf(':');
      const epTitle = colonIdx !== -1 ? titleRaw.slice(colonIdx + 1).trim() : titleRaw;

      const proxyBase = `${req.protocol}://${req.get('host')}`;
      const streamUrl = watchSlug
        ? `${proxyBase}/anime/animedao/source/${watchSlug}`
        : null;

      if (watchSlug && watchUrl) watchUrlCache.set(watchSlug, watchUrl);

      if (titleRaw) {
        episodes.push({
          id: watchSlug,
          episodeId: watchSlug,
          episode: epNum,
          title: epTitle,
          fullTitle: titleRaw,
          date,
          watchUrl,
          streamUrl,
        });
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
 * Returns stream sources (SUB / DUB / HSUB) for a given episode slug.
 * Example: /anime/animedao/source/one-piece-episode-2
 */
router.get('/source/:watchSlug', async (req, res) => {
  const { watchSlug } = req.params;

  const candidates = [
    watchUrlCache.get(watchSlug),
    ...getSlugCandidates(watchSlug).map((s) => `${BASE_URL}/watch-online/${s}`),
  ].filter(Boolean);

  const uniqueCandidates = [...new Set(candidates)];

  const slugMatch = watchSlug.match(/^(.+)-episode-(\d+)$/);
  const animeSlug = slugMatch ? slugMatch[1] : watchSlug;
  const epNum = slugMatch ? parseInt(slugMatch[2]) : null;

  let rawHtml = null;
  let usedUrl = null;

  for (const watchUrl of uniqueCandidates) {
    console.log(`[animedao] trying → ${watchUrl}`);
    try {
      const response = await axios.get(watchUrl, { headers: PAGE_HEADERS, maxRedirects: 5 });
      const html = response.data;

      if (html.includes('404') && html.includes('Pages not found')) {
        console.log(`[animedao] 404 → skipping`);
        continue;
      }

      const $ = cheerio.load(html);
      if ($('ul.server-items').length > 0 || $('[data-video]').length > 0) {
        rawHtml = html;
        usedUrl = watchUrl;
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
    const $ = cheerio.load(rawHtml);
    const allDataVideos = [];
    $('[data-video]').each((_, el) => allDataVideos.push($(el).attr('data-video')));
    return res.status(404).json({
      error: 'Page found but no vibeplayer streams',
      usedUrl,
      dataVideos: allDataVideos,
    });
  }

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  const result = {
    id: watchSlug,
    episodeId: epNum != null ? `episode-${epNum}` : null,
    episode: epNum,
    animeSlug,
    watchUrl: usedUrl,
  };

  await Promise.all(
    Object.entries(categories).map(async ([cat, servers]) => {
      result[cat] = await Promise.all(servers.map((s) => buildStreamEntry(s, proxyBase)));
    })
  );

  res.json(result);
});

/**
 * GET /anime/animedao/details/:anilistId
 *
 * Returns full AniList + TMDB metadata merged with the AnimeDAO episode list.
 * TMDB per-episode data (thumbnail, overview, airDate, rating) is injected
 * into each animedao episode entry when available.
 *
 * The anime slug is auto-resolved by trying the english title, romaji title,
 * and any AniList synonyms as slug candidates against animedao.
 *
 * Example: /anime/animedao/details/21   (21 = One Piece on AniList)
 */
router.get('/details/:anilistId', async (req, res) => {
  const anilistId = parseInt(req.params.anilistId, 10);
  if (isNaN(anilistId)) {
    return res.status(400).json({ error: 'Invalid AniList ID — must be a number' });
  }

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  // ── 1. Fetch AniList media ────────────────────────────────────────────────
  let rawMedia;
  try {
    rawMedia = await fetchAnilistMedia(anilistId);
  } catch (err) {
    return res.status(502).json({ error: 'AniList fetch failed: ' + err.message });
  }
  if (!rawMedia) {
    return res.status(404).json({ error: `No AniList media found for ID ${anilistId}` });
  }

  const media = mapAnilistMedia(rawMedia);

  // ── 2. Kick off TMDB resolution + animedao episode fetch in parallel ──────
  const [tmdbResult, episodeResult] = await Promise.all([
    resolveTMDB(rawMedia).catch((err) => {
      console.warn('[animedao/details] TMDB resolution failed:', err.message);
      return { tmdbId: null, tmdbInfo: null, tmdbLookup: new Map() };
    }),
    resolveAnimeDAOEpisodes(rawMedia, proxyBase),
  ]);

  const { tmdbId, tmdbInfo, tmdbLookup } = tmdbResult;

  // ── 3. Merge TMDB per-episode metadata into animedao episodes ─────────────
  //       tmdbLookup is keyed by absolute episode number (1-based integer)
  const episodes = (episodeResult?.episodes || []).map((ep) => {
    const tmdbEp = ep.episode != null ? tmdbLookup.get(ep.episode) : undefined;
    return {
      // AnimeDAO fields
      id:            ep.id,
      episodeId:     ep.episodeId,
      episode:       ep.episode,
      title:         ep.title,
      fullTitle:     ep.fullTitle,
      date:          ep.date,
      watchUrl:      ep.watchUrl,
      streamUrl:     ep.streamUrl,
      // TMDB enrichment (null when unavailable)
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

  // ── 4. Return combined response ───────────────────────────────────────────
  res.json({
    // ── Series metadata (AniList) ──
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

    // ── Series metadata (TMDB) ──
    tmdbId,
    tmdb: tmdbInfo
      ? {
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
        }
      : null,

    // ── AnimeDAO episode list (enriched with TMDB per-episode data) ──
    animeDAOSlug:  episodeResult?.slug  || null,
    totalEpisodes: episodes.length      || media.totalEpisodes || null,
    episodes,
  });
});

/**
 * GET /anime/animedao/proxy/m3u8?url=<m3u8-url>
 * Proxies and rewrites m3u8 playlists so all segment/key URIs go through this server.
 */
router.get('/proxy/m3u8', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  try {
    const response = await axios.get(url, { headers: HEADERS, responseType: 'text' });
    const rewritten = rewriteM3u8(response.data, url, proxyBase);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch (err) {
    console.error('[animedao] m3u8 proxy error:', err.message);
    res.status(502).send('Failed to fetch m3u8: ' + err.message);
  }
});

/**
 * GET /anime/animedao/proxy/segment?url=<segment-url>
 * Proxies raw media segments (.ts, encryption keys, init segments).
 */
router.get('/proxy/segment', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  try {
    const response = await axios.get(url, { headers: HEADERS, responseType: 'stream' });
    res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
    res.setHeader('Cache-Control', 'max-age=3600');
    response.data.pipe(res);
  } catch (err) {
    console.error('[animedao] segment proxy error:', err.message);
    res.status(502).send('Failed to fetch segment: ' + err.message);
  }
});

/**
 * GET /anime/animedao/player?url=<proxied-m3u8>&sub=<vtt-url>
 * Built-in HLS player with quality selector and optional subtitle track.
 * NOTE: This route is intentionally NOT behind auth so it can be embedded in <video>.
 */
router.get('/player', (req, res) => {
  const { url, sub } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  const subTrack = sub
    ? `<track kind="subtitles" src="${sub}" srclang="en" label="English" default>`
    : '';

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
    #qualitySelect {
      background: #222; color: #fff; border: 1px solid #555;
      padding: 6px 12px; border-radius: 4px; font-size: 14px; cursor: pointer;
    }
    #qualitySelect:hover { border-color: #fff; }
    #qualityLabel { color: #aaa; font-size: 13px; font-family: sans-serif; }
  </style>
</head>
<body>
  <video id="video" controls autoplay crossorigin="anonymous">
    ${subTrack}
  </video>
  <div id="controls">
    <span id="qualityLabel">Quality:</span>
    <select id="qualitySelect"><option value="-1">Auto</option></select>
  </div>
  <script>
    const src   = decodeURIComponent("${encodeURIComponent(url)}");
    const video = document.getElementById("video");
    const sel   = document.getElementById("qualitySelect");

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        video.play();
        data.levels.forEach((level, i) => {
          const opt  = document.createElement("option");
          opt.value  = i;
          opt.text   = level.height ? level.height + "p" : "Level " + i;
          sel.appendChild(opt);
        });
      });

      sel.addEventListener("change", () => {
        hls.currentLevel = parseInt(sel.value);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, () => {
        if (hls.autoLevelEnabled) sel.value = -1;
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) console.error("HLS fatal error:", data.type, data.details);
      });
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