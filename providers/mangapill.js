const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { request, gql } = require('graphql-request');
const archiver = require('archiver');

const router = express.Router();

const ANILIST_API = 'https://graphql.anilist.co';

// Headers for MangaPill
const MANGAPILL_HEADERS = {
  'Referer': 'https://mangapill.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

// NEW: In-memory cache for AniList ID to MangaPill ID mapping
const anilistToMangapillCache = new Map();

// Function to get the proxy base URL dynamically
function getProxyBaseUrl(req) {
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}/manga/mangapill`;
}

// Helper function to proxy image URL
function proxyImageUrl(imageUrl, baseUrl) {
  if (!imageUrl) return null;
  return `${baseUrl}/proxy?url=${encodeURIComponent(imageUrl)}`;
}

// GraphQL query to search manga on AniList
const SEARCH_MANGA_QUERY = gql`
  query ($search: String) {
    Media(search: $search, type: MANGA) {
      id
      title {
        romaji
        english
        native
      }
      description
      coverImage {
        large
        extraLarge
      }
      bannerImage
      genres
      tags {
        name
      }
      averageScore
      popularity
      status
      chapters
      volumes
      startDate {
        year
        month
        day
      }
      endDate {
        year
        month
        day
      }
      synonyms
      siteUrl
    }
  }
`;

// NEW: GraphQL query to get manga by AniList ID
const GET_MANGA_BY_ID_QUERY = gql`
  query ($id: Int) {
    Media(id: $id, type: MANGA) {
      id
      title {
        romaji
        english
        native
      }
      description
      coverImage {
        large
        extraLarge
      }
      bannerImage
      genres
      tags {
        name
      }
      averageScore
      popularity
      status
      chapters
      volumes
      startDate {
        year
        month
        day
      }
      endDate {
        year
        month
        day
      }
      synonyms
      siteUrl
    }
  }
`;

// Function to search AniList
async function searchAniList(mangaTitle) {
  try {
    const data = await request(ANILIST_API, SEARCH_MANGA_QUERY, { 
      search: mangaTitle 
    });
    return data.Media;
  } catch (error) {
    console.error('Error fetching from AniList:', error);
    return null;
  }
}

// NEW: Function to get manga by AniList ID
async function getAniListById(anilistId) {
  try {
    const data = await request(ANILIST_API, GET_MANGA_BY_ID_QUERY, { 
      id: parseInt(anilistId)
    });
    return data.Media;
  } catch (error) {
    console.error('Error fetching from AniList by ID:', error);
    return null;
  }
}

// NEW: Function to search MangaPill by title
async function searchMangaPillByTitle(title) {
  try {
    // Try to search MangaPill's search page
    const searchUrl = `https://mangapill.com/search?q=${encodeURIComponent(title)}`;
    const { data } = await axios.get(searchUrl, {
      headers: MANGAPILL_HEADERS
    });
    
    const $ = cheerio.load(data);
    const results = [];
    
    // Parse search results
    $('.grid > div a[href^="/manga/"]').each((i, el) => {
      const href = $(el).attr('href');
      const mangaTitle = $(el).find('.font-black').text().trim();
      if (href && mangaTitle) {
        results.push({
          id: href.replace('/manga/', ''),
          title: mangaTitle,
          link: href
        });
      }
    });
    
    return results;
  } catch (error) {
    console.error('Error searching MangaPill:', error);
    return [];
  }
}

// ==================== SCRAPER FUNCTIONS ====================

function scrapeMangaFromHTML(html) {
  const $ = cheerio.load(html);
  const mangaList = [];

  $('.featured-grid .rounded').each((i, el) => {
    const $el = $(el);
    
    const fullPath = $el.find('a[href^="/manga/"]').attr('href');
    const id = fullPath ? fullPath.replace('/manga/', '') : null;
    const mangaID = $el.find('a').first().attr('href');
    const cleanMangaID = mangaID ? mangaID.replace('/chapters/', '') : null;
    
    const chapterNumber = $el.find('.text-lg.font-black').text().trim();
    const mangaTitle = $el.find('.text-secondary').text().trim();
    const imageUrl = $el.find('img').attr('src') || $el.find('img').attr('data-src');
    const imageAlt = $el.find('img').attr('alt');

    mangaList.push({
      id,
      chapterNumber,
      mangaID: cleanMangaID,
      mangaTitle,
      imageUrl,
      imageAlt
    });
  });

  return mangaList;
}

function scrapeChaptersPage(html) {
  const $ = cheerio.load(html);
  const chaptersList = [];
  const seenIds = new Set();

  $('.grid > div, .space-y-2 > div').each((i, el) => {
    const $el = $(el);
    
    const chapterLink = $el.find('a[href^="/chapters/"]').first();
    if (chapterLink.length === 0) return;

    const mangaID = chapterLink.attr('href');
    
    if (seenIds.has(mangaID)) return;
    seenIds.add(mangaID);

    const chapterNumber = $el.find('.text-lg.font-black').first().text().trim();
    const imageUrl = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');
    const imageAlt = $el.find('img').first().attr('alt');
    
    const mangaLink = $el.find('a[href^="/manga/"]').first();
    const fullPath = mangaLink.attr('href');
    const id = fullPath ? fullPath.replace('/manga/', '') : null;
    
    const mangaTitleRaw = $el.find('.text-secondary').first().text().trim();
    const titleParts = mangaTitleRaw.split(/\n\s+/);
    const mangaTitle = titleParts[0] || null;
    const mangaTitle2 = titleParts[1] || null;
    
    const timeAgo = $el.find('time-ago').first().attr('datetime');
    const cleanMangaID = mangaID ? mangaID.replace('/chapters/', '') : null;
    
    if (chapterNumber && mangaTitle && cleanMangaID) {
      chaptersList.push({
        id,
        chapterNumber,
        mangaID: cleanMangaID,
        mangaTitle,
        ...(mangaTitle2 && { mangaTitle2 }),
        imageUrl,
        imageAlt,
        publishedAt: timeAgo
      });
    }
  });

  return chaptersList;
}

function scrapeMangaDetails(html) {
  const $ = cheerio.load(html);
  
  const title = $('h1').text().trim();
  const image = $('.flex-shrink-0 img').attr('src') || $('.flex-shrink-0 img').attr('data-src');
  const description = $('.text-sm.text--secondary').text().trim();
  
  const type = $('.grid.grid-cols-1 > div:nth-child(1) > div').text().trim();
  const status = $('.grid.grid-cols-1 > div:nth-child(2) > div').text().trim();
  const year = $('.grid.grid-cols-1 > div:nth-child(3) > div').text().trim();
  
  const genres = [];
  $('a[href^="/search?genre="]').each((i, el) => {
    genres.push($(el).text().trim());
  });
  
  const chapters = [];
  $('#chapters a[href^="/chapters/"]').each((i, el) => {
    const $el = $(el);
    const link = $el.attr('href');
    const chapterId = link ? link.replace('/chapters/', '') : null;
    
    chapters.push({
      title: $el.text().trim(),
      link: link,
      fullTitle: $el.attr('title'),
      chapterId: chapterId
    });
  });
  
  return {
    title,
    image,
    description,
    type,
    status,
    year,
    genres,
    chapters,
    totalChapters: chapters.length
  };
}

function scrapeTrendingMangas(html) {
  const $ = cheerio.load(html);
  const trendingList = [];
  const seenIds = new Set();

  $('.grid > div').each((i, el) => {
    const $el = $(el);
    
    const mangaLink = $el.find('a[href^="/manga/"]').first().attr('href');
    if (!mangaLink) return;
    
    if (seenIds.has(mangaLink)) return;
    seenIds.add(mangaLink);

    const title = $el.find('.font-black.leading-tight').text().trim();
    const alternativeTitle = $el.find('.text-xs.text-secondary').text().trim();
    const imageUrl = $el.find('img').attr('src') || $el.find('img').attr('data-src');
    const imageAlt = $el.find('img').attr('alt');
    
    if (!title || title.includes('#') || title.length < 2) {
      return;
    }
    
    if (alternativeTitle && (alternativeTitle.match(/^\d{4}-\d{2}-\d{2}/) || alternativeTitle.includes('#'))) {
      return;
    }
    
    const tags = [];
    $el.find('.text-xs.leading-5.font-semibold').each((j, tag) => {
      const tagText = $(tag).text().trim();
      if (tagText) tags.push(tagText);
    });
    
    const id = mangaLink.replace('/manga/', '');
    
    if (title && mangaLink) {
      trendingList.push({
        id,
        title,
        alternativeTitle: (alternativeTitle && alternativeTitle.length > 0) ? alternativeTitle : null,
        imageUrl: imageUrl || null,
        imageAlt: imageAlt || null,
        type: tags[0] || null,
        year: tags[1] || null,
        status: tags[2] || null,
        link: mangaLink
      });
    }
  });

  return trendingList;
}

function scrapeChapterPages(html, baseUrl) {
  const $ = cheerio.load(html);
  const pages = [];
  
  const chapterTitle = $('h1').text().trim();
  const breadcrumb = $('.flex.items-center.space-x-1 a[href^="/manga/"]').text().trim();
  
  $('img.js-page').each((i, el) => {
    const $el = $(el);
    const imageUrl = $el.attr('data-src') || $el.attr('src');
    const alt = $el.attr('alt');
    const width = $el.attr('width');
    const height = $el.attr('height');
    
    if (imageUrl) {
      pages.push({
        pageNumber: i + 1,
        imageUrl: proxyImageUrl(imageUrl, baseUrl),
        originalImageUrl: imageUrl,
        alt: alt || null,
        width: width || null,
        height: height || null
      });
    }
  });
  
  return {
    chapterTitle,
    mangaTitle: breadcrumb,
    totalPages: pages.length,
    pages
  };
}

// ==================== ROUTES ====================

// Proxy endpoint to fetch images
router.get('/proxy', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    
    if (!imageUrl) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    if (!imageUrl.includes('readdetectiveconan.com') && !imageUrl.includes('mangapill.com')) {
      return res.status(403).json({ error: 'Invalid image source' });
    }

    const response = await axios({
      method: 'GET',
      url: imageUrl,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://mangapill.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site'
      },
      timeout: 15000,
      maxRedirects: 5
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (error) {
    console.error('Error fetching image:', error.message);
    
    if (error.response) {
      res.status(error.response.status).json({ 
        error: 'Failed to fetch image',
        status: error.response.status,
        details: error.message 
      });
    } else {
      res.status(500).json({ 
        error: 'Failed to fetch image',
        details: error.message 
      });
    }
  }
});

router.get('/featured-mangas', async (req, res) => {
  try {
    const { data } = await axios.get('https://mangapill.com/', {
      headers: MANGAPILL_HEADERS
    });

    const mangaList = scrapeMangaFromHTML(data);
    res.json({
      success: true,
      count: mangaList.length,
      data: mangaList
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/scrape-url', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ 
      error: 'URL query parameter is required',
      example: '/scrape-url?url=https://mangapill.com/'
    });
  }

  try {
    const { data } = await axios.get(url, {
      headers: MANGAPILL_HEADERS
    });

    const mangaList = scrapeMangaFromHTML(data);
    res.json({
      success: true,
      count: mangaList.length,
      data: mangaList
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// MODIFIED: Now supports both MangaPill ID and AniList ID
router.get('/manga-details', async (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ 
      success: false,
      error: 'ID parameter is required (can be MangaPill ID or AniList ID)', 
      examples: {
        mangapill: '/manga-details?id=9268/who-s-that-girl',
        anilist: '/manga-details?id=189080'
      }
    });
  }

  try {
    let mangapillId = id;
    let anilistData = null;
    
    // Check if ID is numeric (AniList ID) or contains "/" (MangaPill ID)
    if (/^\d+$/.test(id)) {
      // It's an AniList ID
      console.log(`Looking up AniList ID: ${id}`);
      
      // Check cache first
      if (anilistToMangapillCache.has(id)) {
        mangapillId = anilistToMangapillCache.get(id);
        console.log(`Found in cache: ${mangapillId}`);
      } else {
        // Fetch from AniList
        anilistData = await getAniListById(id);
        
        if (!anilistData) {
          return res.status(404).json({
            success: false,
            error: 'Manga not found on AniList'
          });
        }
        
        // Try to find on MangaPill using the title
        const searchTitle = anilistData.title.english || anilistData.title.romaji;
        const searchResults = await searchMangaPillByTitle(searchTitle);
        
        if (searchResults.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Manga not found on MangaPill',
            anilist: anilistData,
            suggestion: 'Try searching manually on MangaPill'
          });
        }
        
        // Use the first result
        mangapillId = searchResults[0].id;
        
        // Cache the mapping
        anilistToMangapillCache.set(id, mangapillId);
        console.log(`Cached mapping: ${id} -> ${mangapillId}`);
      }
    }

    // Fetch MangaPill details
    const url = `https://mangapill.com/manga/${mangapillId}`;
    const { data } = await axios.get(url, {
      headers: MANGAPILL_HEADERS
    });

    const mangaDetails = scrapeMangaDetails(data);
    
    // If we haven't fetched AniList data yet, do it now
    if (!anilistData) {
      anilistData = await searchAniList(mangaDetails.title);
    }
    
    // Cache the reverse mapping if we have anilist data
    if (anilistData && anilistData.id) {
      anilistToMangapillCache.set(anilistData.id.toString(), mangapillId);
    }

    res.json({
      success: true,
      url: url,
      mangapillId: mangapillId,
      anilistId: anilistData?.id || null,
      mangaPill: mangaDetails,
      anilist: anilistData
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/get-chapters-list', async (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ 
      success: false,
      error: 'Manga ID parameter is required', 
      example: '/get-chapters-list?id=2/one-piece' 
    });
  }

  try {
    const url = `https://mangapill.com/manga/${id}`;
    const { data } = await axios.get(url, {
      headers: MANGAPILL_HEADERS
    });

    const mangaDetails = scrapeMangaDetails(data);
    
    const chapterIds = mangaDetails.chapters.map(ch => {
      return ch.link.replace('/chapters/', '');
    });

    res.json({
      success: true,
      mangaTitle: mangaDetails.title,
      totalChapters: mangaDetails.totalChapters,
      chapters: mangaDetails.chapters,
      chapterIds: chapterIds,
      downloadMultipleExample: `/download-multiple-chapters?chapterIds=${chapterIds.slice(0, 3).join(',')}&folderName=${mangaDetails.title.replace(/[^a-z0-9]/gi, '_')}`
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/chapter-pages', async (req, res) => {
  const { mangaID } = req.query;

  if (!mangaID) {
    return res.status(400).json({ 
      success: false,
      error: 'mangaID parameter is required', 
      example: '/chapter-pages?mangaID=2-11163000/one-piece-chapter-1163'
    });
  }

  try {
    const url = `https://mangapill.com/chapters/${mangaID}`;
    const { data } = await axios.get(url, {
      headers: MANGAPILL_HEADERS
    });

    const baseUrl = getProxyBaseUrl(req);
    const chapterData = scrapeChapterPages(data, baseUrl);
    
    res.json({
      success: true,
      url: url,
      data: chapterData
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/download-chapter-pages', async (req, res) => {
  const { mangaID } = req.query;

  if (!mangaID) {
    return res.status(400).json({ 
      success: false,
      error: 'mangaID parameter is required', 
      example: '/download-chapter-pages?mangaID=2-11163000/one-piece-chapter-1163'
    });
  }

  try {
    const url = `https://mangapill.com/chapters/${mangaID}`;
    const { data } = await axios.get(url, {
      headers: MANGAPILL_HEADERS
    });

    const baseUrl = getProxyBaseUrl(req);
    const chapterData = scrapeChapterPages(data, baseUrl);
    
    if (chapterData.pages.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No pages found for this chapter'
      });
    }

    const sanitizedTitle = (chapterData.chapterTitle || 'chapter')
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase();
    const zipFilename = `${sanitizedTitle}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    archive.pipe(res);

    let successCount = 0;
    let errorCount = 0;

    for (const page of chapterData.pages) {
      try {
        const imageUrl = page.originalImageUrl;
        
        const imageResponse = await axios({
          method: 'GET',
          url: imageUrl,
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://mangapill.com/',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
          },
          timeout: 30000
        });

        const extension = imageUrl.match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[1] || 'jpg';
        const paddedPageNumber = String(page.pageNumber).padStart(3, '0');
        const filename = `page_${paddedPageNumber}.${extension}`;

        archive.append(Buffer.from(imageResponse.data), { name: filename });
        successCount++;
        
      } catch (imgError) {
        errorCount++;
      }
    }

    await archive.finalize();

  } catch (err) {
    console.error('Error creating ZIP:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
});

router.get('/api/download-multiple/chapters', async (req, res) => {
  const { chapterIds, folderName } = req.query;

  if (!chapterIds) {
    return res.status(400).json({ 
      success: false,
      error: 'chapterIds parameter is required (comma-separated)', 
      example: '/api/download-multiple/chapters?chapterIds=2-11163000/one-piece-chapter-1163,2-11162000/one-piece-chapter-1162&folderName=One_Piece'
    });
  }

  try {
    const decodedIds = decodeURIComponent(chapterIds);
    const chapters = decodedIds.split(',').map(id => id.trim()).filter(id => id);
    
    console.log('📥 Total chapters to process:', chapters.length);
    
    if (chapters.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid chapter IDs provided'
      });
    }

    const sanitizedFolderName = (folderName || 'manga_chapters')
      .replace(/[^a-z0-9\s-_]/gi, '_')
      .replace(/\s+/g, '_');
    
    const zipFilename = `${sanitizedFolderName}.zip`;

    console.log(`\n📦 Creating multi-chapter ZIP: ${zipFilename}`);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    archive.pipe(res);

    let totalSuccess = 0;
    let totalFailed = 0;
    const chapterSummary = [];

    // Batch processing configuration
    const BATCH_SIZE = 10; // More powerful server? Increase to 10 | Getting rate limited? Decrease to 3

    for (let i = 0; i < chapters.length; i += BATCH_SIZE) {
      const batch = chapters.slice(i, Math.min(i + BATCH_SIZE, chapters.length));
      
      await Promise.all(batch.map(async (mangaID, batchIndex) => {
        const chapterIndex = i + batchIndex;
        
        try {
          console.log(`\n📖 Processing chapter ${chapterIndex + 1}/${chapters.length}: ${mangaID}`);
          
          const url = `https://mangapill.com/chapters/${mangaID}`;
          const { data } = await axios.get(url, {
            headers: MANGAPILL_HEADERS,
            timeout: 30000
          });

          const baseUrl = getProxyBaseUrl(req);
          const chapterData = scrapeChapterPages(data, baseUrl);
          
          if (chapterData.pages.length === 0) {
            console.log(`⚠️  No pages found for chapter: ${mangaID}`);
            totalFailed++;
            chapterSummary.push({
              chapter: mangaID,
              status: 'failed',
              reason: 'No pages found'
            });
            return;
          }

          let chapterNumber = 'Unknown';
          const chapterMatch = chapterData.chapterTitle.match(/chapter[\s-]*(\d+)/i);
          if (chapterMatch) {
            chapterNumber = chapterMatch[1];
          } else {
            const idMatch = mangaID.match(/chapter[\s-]*(\d+)/i);
            if (idMatch) {
              chapterNumber = idMatch[1];
            } else {
              const numMatch = mangaID.match(/(\d+)/);
              if (numMatch) {
                chapterNumber = numMatch[1];
              }
            }
          }
          
          const mangaTitle = chapterData.mangaTitle || 'Manga';
          const sanitizedMangaTitle = mangaTitle.replace(/[^a-z0-9\s-]/gi, '_').replace(/\s+/g, '_');
          const chapterFolderName = `${sanitizedMangaTitle}_Chapter_${chapterNumber}`;
          
          let chapterSuccessCount = 0;
          let chapterFailCount = 0;

          // Process pages in parallel batches
          const PAGE_BATCH_SIZE = 5;
          for (let p = 0; p < chapterData.pages.length; p += PAGE_BATCH_SIZE) {
            const pageBatch = chapterData.pages.slice(p, Math.min(p + PAGE_BATCH_SIZE, chapterData.pages.length));
            
            await Promise.all(pageBatch.map(async (page) => {
              try {
                const imageUrl = page.originalImageUrl;
                
                const imageResponse = await axios({
                  method: 'GET',
                  url: imageUrl,
                  responseType: 'arraybuffer',
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://mangapill.com/',
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
                  },
                  timeout: 30000
                });

                const extension = imageUrl.match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[1] || 'jpg';
                const paddedPageNumber = String(page.pageNumber).padStart(3, '0');
                const filename = `${chapterFolderName}/page_${paddedPageNumber}.${extension}`;

                archive.append(Buffer.from(imageResponse.data), { name: filename });
                chapterSuccessCount++;
                
              } catch (imgError) {
                chapterFailCount++;
                console.error(`  ✗ Failed page ${page.pageNumber}:`, imgError.message);
              }
            }));
          }

          const chapterInfo = `Chapter: ${chapterData.chapterTitle}
Manga: ${chapterData.mangaTitle}
Chapter ID: ${mangaID}
Total Pages: ${chapterData.totalPages}
Successfully Downloaded: ${chapterSuccessCount}
Failed: ${chapterFailCount}
Source URL: ${url}
`;
          archive.append(chapterInfo, { name: `${chapterFolderName}/info.txt` });

          totalSuccess += chapterSuccessCount;
          totalFailed += chapterFailCount;
          
          chapterSummary.push({
            chapter: mangaID,
            title: chapterData.chapterTitle,
            status: 'success',
            pagesDownloaded: chapterSuccessCount,
            pagesFailed: chapterFailCount
          });

          console.log(`  ✓ Chapter complete: ${chapterSuccessCount} pages`);
          
        } catch (chapterError) {
          console.error(`✗ Failed to process chapter ${mangaID}:`, chapterError.message);
          totalFailed++;
          chapterSummary.push({
            chapter: mangaID,
            status: 'failed',
            reason: chapterError.message
          });
        }
      }));
    }

    const readme = `Multi-Chapter Download Summary
================================

Folder Name: ${sanitizedFolderName}
Total Chapters Requested: ${chapters.length}
Total Pages Downloaded: ${totalSuccess}
Total Pages Failed: ${totalFailed}

Generated: ${new Date().toISOString()}
`;
    archive.append(readme, { name: 'README.txt' });

    await archive.finalize();

    console.log(`\n✅ Multi-chapter ZIP completed`);

  } catch (err) {
    console.error('Error creating multi-chapter ZIP:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
});

router.get('/recent-chapters', async (req, res) => {
  try {
    const { data } = await axios.get('https://mangapill.com/chapters', {
      headers: MANGAPILL_HEADERS
    });

    const chaptersList = scrapeChaptersPage(data);
    res.json({
      success: true,
      count: chaptersList.length,
      data: chaptersList
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/trending-mangas', async (req, res) => {
  try {
    const { data } = await axios.get('https://mangapill.com/', {
      headers: MANGAPILL_HEADERS
    });

    const trendingList = scrapeTrendingMangas(data);
    res.json({
      success: true,
      count: trendingList.length,
      data: trendingList
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/', (req, res) => {
  res.json({
    provider: 'Mangapill',
    version: '2.0.0',
    baseUrl: 'https://mangapill.com/',
    features: [
      'Supports both MangaPill IDs and AniList IDs',
      'Automatic ID mapping and caching',
      'AniList integration for enhanced metadata',
      'Batch processing for multiple chapters (configurable: 3-10 concurrent)'
    ],
    endpoints: [
      {
        method: "GET",
        path: "/proxy?url=IMAGE_URL",
        description: "Proxy manga images to bypass CORS",
        example: "/proxy?url=https://cdn.readdetectiveconan.com/file/mangap/..."
      },
      {
        method: "GET",
        path: "/health",
        description: "Health check endpoint"
      },
      {
        method: "GET",
        path: "/featured-mangas",
        description: "Scrape featured manga from MangaPill homepage"
      },
      {
        method: "GET",
        path: "/scrape-url?url=YOUR_URL",
        description: "Scrape from custom URL",
        example: "/scrape-url?url=https://mangapill.com/"
      },
      {
        method: "GET",
        path: "/manga-details?id=ID",
        description: "Get manga details (supports both MangaPill ID and AniList ID)",
        examples: {
          mangapill: "/manga-details?id=9268/who-s-that-girl",
          anilist: "/manga-details?id=189080"
        }
      },
      {
        method: "GET",
        path: "/get-chapters-list?id=MANGA_ID",
        description: "Get list of all available chapters for a manga",
        example: "/get-chapters-list?id=2/one-piece"
      },
      {
        method: "GET",
        path: "/chapter-pages?mangaID=MANGA_ID",
        description: "Get all pages/images from a manga chapter",
        example: "/chapter-pages?mangaID=2-11163000/one-piece-chapter-1163"
      },
      {
        method: "GET",
        path: "/download-chapter-pages?mangaID=MANGA_ID",
        description: "Download all chapter pages to a folder on the server",
        example: "/download-chapter-pages?mangaID=2-11163000/one-piece-chapter-1163"
      },
      {
        method: "GET",
        path: "/api/download-multiple/chapters?chapterIds=ID1,ID2,ID3&folderName=FOLDER_NAME",
        description: "Download multiple chapters as a single ZIP file with organized folders (supports unlimited chapters with batch processing)",
        examples: {
          single: "/api/download-multiple/chapters?chapterIds=2-11163000/one-piece-chapter-1163&folderName=One_Piece",
          multiple: "/api/download-multiple/chapters?chapterIds=2-11163000/one-piece-chapter-1163,2-11162000/one-piece-chapter-1162&folderName=One_Piece",
          many: "/api/download-multiple/chapters?chapterIds=2-11163000/one-piece-chapter-1163,2-11162000/one-piece-chapter-1162,2-11161000/one-piece-chapter-1161,2-11160000/one-piece-chapter-1160,2-11159000/one-piece-chapter-1159&folderName=One_Piece_Batch"
        },
        notes: "Processes chapters in batches of 10 (configurable). Adjust BATCH_SIZE in code: 10 for powerful servers, 3 if rate limited"
      },
      {
        method: "GET",
        path: "/recent-chapters",
        description: "Scrape latest chapters from MangaPill chapters page"
      },
      {
        method: "GET",
        path: "/trending-mangas",
        description: "Scrape trending mangas from MangaPill"
      }
    ]
  });
});

module.exports = router;