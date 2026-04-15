const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { request, gql } = require('graphql-request');
const archiver = require('archiver');
const path = require('path');
const dns = require('dns');

const router = express.Router();

// Set DNS servers to Google's public DNS for better resolution
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const ANILIST_API = 'https://graphql.anilist.co';

// Retry helper function
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Fetching ${url} (attempt ${i + 1}/${retries})`);
      const response = await axios.get(url, {
        ...options,
        timeout: options.timeout || 15000
      });
      return response;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      
      if (i === retries - 1) {
        throw error;
      }
      
      // Exponential backoff
      const delay = 1000 * Math.pow(2, i);
      console.log(`Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// NEW: Function to extract manga internal ID from page HTML
async function getMangaInternalId(mangaSlug) {
  try {
    const url = `https://mangabuddy.com/${mangaSlug}`;
    console.log(`🔍 Extracting manga ID from: ${url}`);
    
    const response = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Look for the manga ID in various places
    let mangaId = null;
    
    // Method 1: Check script tags for manga_id or similar
    $('script').each((i, elem) => {
      const content = $(elem).html();
      if (content && !mangaId) {
        // Look for patterns like: var bookId = 21293, manga_id: 21293, mangaId: 21293, "id":21293
        const patterns = [
          /var\s+bookId\s*=\s*(\d+)/i,           // NEW: var bookId = 21293
          /manga[_-]?id["\s:=]+['"]?(\d+)/i,
          /"id"\s*:\s*(\d+)/,
          /data-manga-id=['"](\d+)['"]/,
          /\/api\/manga\/(\d+)\//
        ];
        
        for (const pattern of patterns) {
          const match = content.match(pattern);
          if (match) {
            mangaId = match[1];
            console.log(`   ✅ Found ID via pattern in script: ${mangaId}`);
            break;
          }
        }
      }
    });

    // Method 2: Check data attributes
    if (!mangaId) {
      const dataId = $('[data-manga-id]').attr('data-manga-id') || 
                     $('[data-id]').attr('data-id');
      if (dataId) {
        mangaId = dataId;
        console.log(`   ✅ Found ID via data attribute: ${mangaId}`);
      }
    }

    // Method 3: Check meta tags
    if (!mangaId) {
      const metaId = $('meta[name="manga-id"]').attr('content') ||
                     $('meta[property="manga:id"]').attr('content');
      if (metaId) {
        mangaId = metaId;
        console.log(`   ✅ Found ID via meta tag: ${mangaId}`);
      }
    }

    if (!mangaId) {
      console.log(`   ❌ Could not find manga ID in page`);
    }

    return mangaId;
  } catch (error) {
    console.error('   ❌ Error extracting manga ID:', error.message);
    return null;
  }
}

// NEW: Function to fetch ALL chapters from API
async function getAllChapters(mangaId) {
  try {
    // Use limit=9999 to get ALL chapters in one request
    const apiUrl = `https://mangabuddy.com/api/manga/${mangaId}/chapters?source=detail&limit=9999`;
    console.log(`Fetching all chapters from API: ${apiUrl}`);
    
    const response = await fetchWithRetry(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://mangabuddy.com/`
      }
    });

    // The API returns plain text/HTML, not JSON
    const html = response.data;
    console.log(`Response length: ${html.length} characters`);
    
    // Parse with cheerio
    const $ = cheerio.load(html);
    const chapters = [];

    // The API returns a simple list - try multiple selectors
    // Pattern 1: Direct <a> tags
    $('a').each((i, elem) => {
      const $link = $(elem);
      const href = $link.attr('href');
      
      if (!href || !href.includes('/chapter-')) {
        return; // Skip non-chapter links
      }
      
      // Get text content - the chapter title is directly in the <a> tag
      const fullText = $link.text().trim();
      
      // Extract chapter title and date
      // Format is usually: "Chapter 482Dec 08, 2025" or "Chapter 482 Dec 08, 2025"
      const match = fullText.match(/^(Chapter\s+[\d.]+)(.*)$/i);
      
      let chapterTitle = fullText;
      let date = null;
      
      if (match) {
        chapterTitle = match[1].trim();
        date = match[2].trim() || null;
      }
      
      // Build chapter ID from href
      let chapterId = '';
      try {
        const urlObj = new URL(href.startsWith('http') ? href : `https://mangabuddy.com${href}`);
        chapterId = urlObj.pathname.substring(1);
      } catch (e) {
        chapterId = href.replace(/^\//, '').replace(/^https?:\/\/mangabuddy\.com\//, '');
      }
      
      chapters.push({
        title: chapterTitle,
        url: href.startsWith('http') ? href : `https://mangabuddy.com${href}`,
        date: date,
        chapterId: chapterId
      });
    });

    console.log(`✅ Fetched ${chapters.length} chapters from API`);
    
    // Debug: Show first and last few chapters
    if (chapters.length > 0) {
      console.log(`First chapter: ${chapters[0].title}`);
      console.log(`Last chapter: ${chapters[chapters.length - 1].title}`);
    }
    
    return chapters;
  } catch (error) {
    console.error('Error fetching chapters from API:', error.message);
    return null;
  }
}

// AniList GraphQL Query
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

// AniList search function
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

// NEW: Scrape latest manga updates
router.get('/api/latest', async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const url = page > 1 
      ? `https://mangabuddy.com/latest?page=${page}`
      : 'https://mangabuddy.com/latest';
    
    console.log(`Fetching latest manga from: ${url}`);
    
    const response = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://mangabuddy.com/'
      }
    });

    const $ = cheerio.load(response.data);
    const mangaList = [];

    // Parse each book item
    $('.book-item').each((i, elem) => {
      const $item = $(elem);
      
      // Extract basic info
      const $link = $item.find('.thumb a, .title a').first();
      const href = $link.attr('href');
      const title = $link.attr('title') || $item.find('.title h3 a').text().trim();
      
      if (!href || !title) return; // Skip invalid items
      
      // Get manga slug from href
      const mangaSlug = href.replace(/^\//, '');
      
      // Get thumbnail (prioritize data-src to avoid placeholder images)
      const thumbnail = $item.find('.thumb img').attr('data-src') || 
                       $item.find('.thumb img').attr('src');
      
      // Get latest chapter
      const latestChapter = $item.find('.latest-chapter').text().trim();
      
      // Build chapterId from latestChapter (e.g., "Chapter 199" -> "mistake/chapter-199")
      let latestChapterId = null;
      if (latestChapter) {
        const chapterMatch = latestChapter.match(/Chapter\s+([\d.]+)/i);
        if (chapterMatch) {
          const chapterNumber = chapterMatch[1];
          latestChapterId = `${mangaSlug}/chapter-${chapterNumber}`;
        }
      }
      
      // Get views
      const viewsText = $item.find('.views span').first().text().trim();
      
      // Get rating
      const ratingScore = $item.find('.rating .score').text().trim();
      const maxRating = $item.find('.rating .max-ratings').text().trim();
      const votes = $item.find('.rating .rate-volumes').text().trim();
      
      // Get genres
      const genres = [];
      $item.find('.genres span').each((j, genreElem) => {
        genres.push($(genreElem).text().trim());
      });
      
      // Get summary
      const summary = $item.find('.summary p').text().trim();
      
      // Get comments count
      const commentsText = $item.find('.views .fa-comment').parent().find('span').text().trim();
      
      mangaList.push({
        title: title,
        slug: mangaSlug,
        url: `https://mangabuddy.com${href}`,
        thumbnail: thumbnail,
        latestChapter: latestChapter,
        latestChapterId: latestChapterId,
        latestChapterUrl: latestChapterId ? `https://mangabuddy.com/${latestChapterId}` : null,
        views: viewsText,
        rating: {
          score: ratingScore,
          maxRating: maxRating,
          votes: votes.replace(/[()]/g, '')
        },
        comments: commentsText,
        genres: genres,
        summary: summary
      });
    });

    // Get pagination info
    const totalPages = $('.pagination .page-item:not(.disabled)').length;
    const currentPage = parseInt(page);
    const hasNextPage = $('.pagination .page-item.active').next('.page-item:not(.disabled)').length > 0;
    const hasPrevPage = currentPage > 1;

    res.json({
      success: true,
      data: {
        currentPage: currentPage,
        totalPages: totalPages || 1,
        hasNextPage: hasNextPage,
        hasPrevPage: hasPrevPage,
        totalManga: mangaList.length,
        manga: mangaList
      }
    });

  } catch (error) {
    console.error('Error fetching latest manga:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message,
      code: error.code
    });
  }
});

// Connection test endpoint
router.get('/api/test-connection', async (req, res) => {
  try {
    const dnsPromises = require('dns').promises;
    
    // Test DNS resolution
    console.log('Testing DNS resolution...');
    const addresses = await dnsPromises.resolve4('mangabuddy.com');
    
    // Test HTTP connection
    console.log('Testing HTTP connection...');
    const response = await axios.get('https://mangabuddy.com', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    res.json({
      success: true,
      dnsResolved: addresses,
      httpStatus: response.status,
      message: 'Connection successful! MangaBuddy is reachable.',
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      code: error.code,
      details: {
        isDnsError: error.code === 'ENOTFOUND',
        isTimeout: error.code === 'ETIMEDOUT',
        isRefused: error.code === 'ECONNREFUSED',
        suggestion: error.code === 'ENOTFOUND' 
          ? 'DNS cannot resolve mangabuddy.com. Check your network/DNS settings.'
          : 'Connection issue. Site might be down or blocking requests.'
      }
    });
  }
});

// Debug endpoint
router.get('/api/debug/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    const url = `https://mangabuddy.com/${mangaId}/${chapterId}`;

    const response = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Get all img tags
    const allImages = [];
    $('img').each((i, elem) => {
      allImages.push({
        src: $(elem).attr('src'),
        'data-src': $(elem).attr('data-src'),
        'data-lazy': $(elem).attr('data-lazy'),
        'data-original': $(elem).attr('data-original'),
        alt: $(elem).attr('alt'),
        class: $(elem).attr('class'),
        id: $(elem).attr('id')
      });
    });

    // Get all scripts containing image data
    const scripts = [];
    $('script').each((i, elem) => {
      const content = $(elem).html();
      if (content && (content.includes('image') || content.includes('page') || content.includes('chapter'))) {
        scripts.push(content.substring(0, 500));
      }
    });

    // Get all scripts content for debugging
    const allScripts = [];
    $('script').each((i, elem) => {
      const content = $(elem).html();
      if (content && (content.includes('image') || content.includes('mbcdns') || content.includes('chapter'))) {
        allScripts.push({
          index: i,
          snippet: content.substring(0, 1000),
          length: content.length
        });
      }
    });

    res.json({
      url: url,
      totalImages: allImages.length,
      images: allImages,
      scriptSnippets: scripts,
      scriptsWithImageData: allScripts,
      bodySnippet: $('body').html().substring(0, 2000)
    });

  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message,
      code: error.code,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Main scraper - with path parameters
router.get('/api/scrape/chapter/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    const url = `https://mangabuddy.com/${mangaId}/${chapterId}`;
    
    const response = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://mangabuddy.com/',
        'Connection': 'keep-alive'
      }
    });

    const $ = cheerio.load(response.data);
    const chapterTitle = $('h1').first().text().trim() || 'Chapter';

    // Extract images with their actual page numbers
    const imageMap = new Map(); // Use Map to preserve page number -> URL mapping
    
    // Method 1: Get images from img tags with alt text containing page numbers
    $('img').each((i, elem) => {
      const $elem = $(elem);
      const src = $elem.attr('src') || $elem.attr('data-src') || $elem.attr('data-original');
      const alt = $elem.attr('alt') || '';
      
      if (src && src.includes('mbcdns')) {
        // Try to extract page number from alt text
        // Format: "Nano Machine - Chapter 223 - Page 11"
        const pageMatch = alt.match(/Page\s+(\d+)/i);
        const pageNum = pageMatch ? parseInt(pageMatch[1]) : null;
        
        if (pageNum) {
          imageMap.set(pageNum, src);
        } else {
          // If no page number in alt, we'll add it later
          if (!imageMap.has(src)) {
            imageMap.set(`temp_${i}`, src);
          }
        }
      }
    });

    // Method 2: Extract URLs from script tags (fallback for images not in DOM)
    const scriptImageUrls = [];
    $('script').each((i, elem) => {
      const scriptText = $(elem).html() || '';
      if (!scriptText) return;
      
      const regex = /https?:\/\/s\d+\.mbcdns[a-z]+\.org\/[^\s"',]+\.(?:jpg|jpeg|png|webp)/gi;
      const matches = scriptText.match(regex);
      
      if (matches) {
        matches.forEach(url => {
          let cleanUrl = url.replace(/[\\",;)\]]+$/, '');
          scriptImageUrls.push(cleanUrl);
        });
      }
    });

    // Merge script images with imageMap
    scriptImageUrls.forEach((url, index) => {
      // Check if this URL is already in the map
      let urlExists = false;
      for (let [key, value] of imageMap.entries()) {
        if (value === url) {
          urlExists = true;
          break;
        }
      }
      
      if (!urlExists) {
        // Find the next available page number
        let pageNum = 1;
        while (imageMap.has(pageNum)) {
          pageNum++;
        }
        imageMap.set(pageNum, url);
      }
    });

    // Convert Map to array and sort by page number
    const pages = [];
    const sortedEntries = Array.from(imageMap.entries())
      .filter(([key]) => typeof key === 'number') // Only numeric keys
      .sort((a, b) => a[0] - b[0]); // Sort by page number

    sortedEntries.forEach(([pageNum, url]) => {
      pages.push({
        page: pageNum,
        imageUrl: url,
        alt: `Page ${pageNum}`
      });
    });

    // If no pages with numbers found, fall back to URL-based sorting
    if (pages.length === 0) {
      const allUrls = Array.from(new Set([...Array.from(imageMap.values()), ...scriptImageUrls]));
      
      allUrls.forEach((url, index) => {
        pages.push({
          page: index + 1,
          imageUrl: url,
          alt: `Page ${index + 1}`
        });
      });

      // Sort by CDN subdomain number (s1, s2, s3, etc)
      pages.sort((a, b) => {
        const aMatch = a.imageUrl.match(/s(\d+)\./);
        const bMatch = b.imageUrl.match(/s(\d+)\./);
        const aNum = aMatch ? parseInt(aMatch[1]) : 0;
        const bNum = bMatch ? parseInt(bMatch[1]) : 0;
        return aNum - bNum;
      });

      // Renumber after sorting
      pages.forEach((page, index) => {
        page.page = index + 1;
        page.alt = `Page ${index + 1}`;
      });
    }

    // Get the base URL from the request
    const protocol = req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}/manga/mangabuddy`;

    res.json({
      success: true,
      data: {
        title: chapterTitle,
        url: url,
        mangaId: mangaId,
        chapterId: chapterId,
        totalPages: pages.length,
        pages: pages.map(p => ({
          ...p,
          proxiedUrl: `${baseUrl}/api/image-proxy?url=${encodeURIComponent(p.imageUrl)}`
        })),
        note: pages.length === 0 ? 'No images found.' : 'All images found!'
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message,
      code: error.code,
      suggestion: error.code === 'ENOTFOUND' 
        ? 'Cannot reach mangabuddy.com. Check network connectivity.'
        : 'Failed to scrape chapter. Site might be down or blocking requests.'
    });
  }
});

// UPDATED: Scrape manga details and chapter list WITH complete chapters from API
router.get('/api/scrape/manga/:mangaId', async (req, res) => {
  try {
    const { mangaId } = req.params;
    const { internalId } = req.query; // Allow manual override via ?internalId=21293
    const url = `https://mangabuddy.com/${mangaId}`;
    
    const response = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Extract manga info from MangaBuddy
    const title = $('h1').first().text().trim() || $('.manga-title').text().trim();
    const description = $('.summary').text().trim() || $('.description').text().trim();
    const cover = $('img.manga-cover').attr('src') || $('.manga-image img').attr('src');
    
    // Get the internal manga ID (manual override or auto-detect)
    let internalMangaId = internalId || await getMangaInternalId(mangaId);
    
    if (internalId) {
      console.log(`✅ Using manually provided internal ID: ${internalMangaId}`);
    } else {
      console.log(`✅ Internal manga ID found: ${internalMangaId}`);
    }
    
    let chapters = [];
    let dataSource = 'HTML';
    
    // Try to fetch chapters from API if we have the internal ID
    if (internalMangaId) {
      console.log(`🔄 Attempting to fetch chapters from API...`);
      const apiChapters = await getAllChapters(internalMangaId);
      
      if (apiChapters && apiChapters.length > 0) {
        chapters = apiChapters;
        dataSource = 'API';
        console.log(`✅ SUCCESS! Using API chapters: ${chapters.length} total`);
        console.log(`   First: ${chapters[0]?.title}, Last: ${chapters[chapters.length - 1]?.title}`);
      } else {
        console.log(`❌ API returned no chapters or failed`);
      }
    } else {
      console.log(`❌ Could not find internal manga ID, skipping API`);
    }
    
    // Fallback: Extract chapters from HTML if API failed
    if (chapters.length === 0) {
      console.log('⚠️ Falling back to HTML parsing from main page');
      $('#chapter-list li, .chapter-list li').each((i, elem) => {
        const $elem = $(elem);
        const $link = $elem.find('a');
        const href = $link.attr('href');
        const chapterTitle = $link.find('.chapter-title, strong').text().trim();
        const date = $link.find('.chapter-update, time').text().trim();
        
        if (href && chapterTitle) {
          let chapterId = '';
          try {
            const urlObj = new URL(href.startsWith('http') ? href : `https://mangabuddy.com${href}`);
            chapterId = urlObj.pathname.substring(1);
          } catch (e) {
            chapterId = href.replace(/^\//, '').replace(/^https?:\/\/mangabuddy\.com\//, '');
          }
          
          chapters.push({
            title: chapterTitle,
            url: href.startsWith('http') ? href : `https://mangabuddy.com${href}`,
            date: date || null,
            chapterId: chapterId
          });
        }
      });
    }

    // Fetch AniList data
    let aniListData = null;
    if (title) {
      console.log(`Searching AniList for: ${title}`);
      aniListData = await searchAniList(title);
    }

    // Prepare response with combined data
    const responseData = {
      success: true,
      data: {
        // MangaBuddy data
        mangaBuddy: {
          title: title,
          description: description,
          cover: cover,
          mangaId: mangaId,
          internalId: internalMangaId,
          url: url,
          totalChapters: chapters.length,
          chapters: chapters,
          dataSource: internalMangaId ? 'API' : 'HTML'
        },
        // AniList data (if found)
        aniList: aniListData ? {
          id: aniListData.id,
          title: aniListData.title,
          description: aniListData.description,
          coverImage: aniListData.coverImage,
          bannerImage: aniListData.bannerImage,
          genres: aniListData.genres,
          tags: aniListData.tags?.map(t => t.name) || [],
          averageScore: aniListData.averageScore,
          popularity: aniListData.popularity,
          status: aniListData.status,
          chapters: aniListData.chapters,
          volumes: aniListData.volumes,
          startDate: aniListData.startDate,
          endDate: aniListData.endDate,
          synonyms: aniListData.synonyms,
          siteUrl: aniListData.siteUrl
        } : null
      }
    };

    res.json(responseData);

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message,
      code: error.code
    });
  }
});

// AniList Query by ID
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
        rank
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
      staff {
        edges {
          role
          node {
            name {
              full
            }
          }
        }
      }
    }
  }
`;

// Function to get manga by AniList ID
async function getMangaById(anilistId) {
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

// New endpoint: Search AniList directly
router.get('/api/anilist/search', async (req, res) => {
  try {
    const { title } = req.query;
    
    if (!title) {
      return res.status(400).json({ 
        success: false,
        error: 'Title parameter required' 
      });
    }

    const aniListData = await searchAniList(title);
    
    if (!aniListData) {
      return res.json({
        success: false,
        message: 'No results found'
      });
    }

    res.json({
      success: true,
      data: aniListData
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Helper function to search MangaBuddy by title
async function searchMangaBuddyByTitle(title) {
  try {
    // Clean the title for URL (lowercase, replace spaces with hyphens)
    const searchSlug = title.toLowerCase()
      .replace(/[^\w\s-]/g, '') // Remove special chars
      .replace(/\s+/g, '-')      // Replace spaces with hyphens
      .replace(/-+/g, '-')       // Replace multiple hyphens with single
      .trim();

    console.log(`Attempting to fetch MangaBuddy: ${searchSlug}`);
    
    const url = `https://mangabuddy.com/${searchSlug}`;
    const response = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    
    // Get the internal manga ID
    const internalMangaId = await getMangaInternalId(searchSlug);
    
    let chapters = [];
    
    // Try to fetch chapters from API if we have the internal ID
    if (internalMangaId) {
      const apiChapters = await getAllChapters(internalMangaId);
      if (apiChapters && apiChapters.length > 0) {
        chapters = apiChapters;
      }
    }
    
    // Fallback to HTML parsing
    if (chapters.length === 0) {
      $('#chapter-list li, .chapter-list li, .chapter-item').each((i, elem) => {
        const $elem = $(elem);
        const $link = $elem.find('a');
        const href = $link.attr('href');
        const chapterTitle = $link.find('.chapter-title, strong, .chap-name').text().trim() || $link.text().trim();
        const date = $elem.find('.chapter-update, time, .chapter-time').text().trim();
        
        if (href && chapterTitle) {
          let chapterId = '';
          try {
            const urlObj = new URL(href.startsWith('http') ? href : `https://mangabuddy.com${href}`);
            chapterId = urlObj.pathname.substring(1);
          } catch (e) {
            chapterId = href.replace(/^\//, '').replace(/^https?:\/\/mangabuddy\.com\//, '');
          }
          
          chapters.push({
            title: chapterTitle,
            url: href.startsWith('http') ? href : `https://mangabuddy.com${href}`,
            date: date || null,
            chapterId: chapterId
          });
        }
      });
    }

    if (chapters.length > 0) {
      return {
        found: true,
        mangaSlug: searchSlug,
        internalId: internalMangaId,
        totalChapters: chapters.length,
        chapters: chapters
      };
    }
    
    return { found: false };
  } catch (error) {
    console.error(`MangaBuddy search failed: ${error.message}`);
    return { found: false };
  }
}

// New endpoint: Get manga by AniList ID with MangaBuddy chapters
router.get('/api/anilist/:anilistId', async (req, res) => {
  try {
    const { anilistId } = req.params;
    const { slug } = req.query; // Allow manual override via ?slug=zombie-dad
    
    // Fetch AniList data
    const aniListData = await getMangaById(anilistId);
    
    if (!aniListData) {
      return res.status(404).json({
        success: false,
        message: 'Manga not found on AniList'
      });
    }

    // Try to find on MangaBuddy
    let mangaBuddyData = null;
    let searchInfo = {};
    
    // If manual slug provided, use it directly
    if (slug) {
      console.log(`Using manually provided slug: ${slug}`);
      mangaBuddyData = await searchMangaBuddyByTitle(slug);
      searchInfo = {
        method: 'manual_slug',
        slug: slug
      };
    } else {
      // Try multiple title variations
      const titlesToTry = [
        aniListData.title.english,
        aniListData.title.romaji,
        aniListData.title.native,
        ...(aniListData.synonyms || [])
      ].filter(Boolean); // Remove null/undefined values
      
      console.log(`Trying ${titlesToTry.length} title variations...`);
      
      for (const title of titlesToTry) {
        console.log(`Searching MangaBuddy for: ${title}`);
        mangaBuddyData = await searchMangaBuddyByTitle(title);
        
        if (mangaBuddyData.found) {
          console.log(`✅ Found using title: ${title}`);
          break;
        }
      }
      
      searchInfo = {
        method: 'auto_search',
        titlesAttempted: titlesToTry.length,
        found: mangaBuddyData && mangaBuddyData.found
      };
    }

    res.json({
      success: true,
      data: {
        aniList: aniListData,
        mangaBuddy: mangaBuddyData && mangaBuddyData.found ? mangaBuddyData : null
      },
      searchInfo: searchInfo
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Helper function to scrape chapter internally
async function scrapeChapterInternal(mangaId, chapterId) {
  const url = `https://mangabuddy.com/${mangaId}/${chapterId}`;
  
  const response = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://mangabuddy.com/'
    }
  });

  const $ = cheerio.load(response.data);
  const chapterTitle = $('h1').first().text().trim() || 'Chapter';

  // Extract images with their actual page numbers
  const imageMap = new Map();
  
  // Method 1: Get images from img tags with alt text containing page numbers
  $('img').each((i, elem) => {
    const $elem = $(elem);
    const src = $elem.attr('src') || $elem.attr('data-src') || $elem.attr('data-original');
    const alt = $elem.attr('alt') || '';
    
    if (src && src.includes('mbcdns')) {
      const pageMatch = alt.match(/Page\s+(\d+)/i);
      const pageNum = pageMatch ? parseInt(pageMatch[1]) : null;
      
      if (pageNum) {
        imageMap.set(pageNum, src);
      } else {
        if (!imageMap.has(src)) {
          imageMap.set(`temp_${i}`, src);
        }
      }
    }
  });

  // Method 2: Extract URLs from script tags
  const scriptImageUrls = [];
  $('script').each((i, elem) => {
    const scriptText = $(elem).html() || '';
    if (!scriptText) return;
    
    const regex = /https?:\/\/s\d+\.mbcdns[a-z]+\.org\/[^\s"',]+\.(?:jpg|jpeg|png|webp)/gi;
    const matches = scriptText.match(regex);
    
    if (matches) {
      matches.forEach(url => {
        scriptImageUrls.push(url.replace(/[\\",;)\]]+$/, ''));
      });
    }
  });

  // Merge script images
  scriptImageUrls.forEach((url) => {
    let urlExists = false;
    for (let [key, value] of imageMap.entries()) {
      if (value === url) {
        urlExists = true;
        break;
      }
    }
    
    if (!urlExists) {
      let pageNum = 1;
      while (imageMap.has(pageNum)) {
        pageNum++;
      }
      imageMap.set(pageNum, url);
    }
  });

  // Convert Map to array and sort
  const pages = [];
  const sortedEntries = Array.from(imageMap.entries())
    .filter(([key]) => typeof key === 'number')
    .sort((a, b) => a[0] - b[0]);

  sortedEntries.forEach(([pageNum, url]) => {
    pages.push({
      page: pageNum,
      imageUrl: url,
      alt: `Page ${pageNum}`
    });
  });

  // Fallback to URL-based sorting if needed
  if (pages.length === 0) {
    const allUrls = Array.from(new Set([...Array.from(imageMap.values()), ...scriptImageUrls]));
    
    allUrls.forEach((url, index) => {
      pages.push({
        page: index + 1,
        imageUrl: url,
        alt: `Page ${index + 1}`
      });
    });

    pages.sort((a, b) => {
      const aMatch = a.imageUrl.match(/s(\d+)\./);
      const bMatch = b.imageUrl.match(/s(\d+)\./);
      return (aMatch ? parseInt(aMatch[1]) : 0) - (bMatch ? parseInt(bMatch[1]) : 0);
    });

    pages.forEach((page, index) => {
      page.page = index + 1;
      page.alt = `Page ${index + 1}`;
    });
  }

  return {
    title: chapterTitle,
    url: url,
    mangaId: mangaId,
    chapterId: chapterId,
    totalPages: pages.length,
    pages: pages
  };
}

// Download chapter as ZIP
router.get('/api/download/chapter/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    
    console.log(`Starting download for: ${mangaId}/${chapterId}`);
    
    // Scrape the chapter directly instead of making HTTP request
    const chapterData = await scrapeChapterInternal(mangaId, chapterId);
    
    if (!chapterData.pages || chapterData.pages.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Chapter not found or no pages available'
      });
    }

    const pages = chapterData.pages;
    
    console.log(`Found ${pages.length} pages to download`);

    // Set response headers for ZIP download
    const zipFilename = `${mangaId}_${chapterId}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    // Create ZIP archive
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Pipe archive to response
    archive.pipe(res);

    // Download and add each image to the ZIP
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      console.log(`Downloading page ${page.page}/${pages.length}...`);

      try {
        const imageResponse = await fetchWithRetry(page.imageUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://mangabuddy.com/',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
          },
          timeout: 30000
        });

        // Get file extension from URL or content-type
        const urlExt = path.extname(page.imageUrl).split('?')[0] || '.jpg';
        const ext = urlExt || '.jpg';
        
        // Add image to ZIP with padded page number
        const paddedPageNum = String(page.page).padStart(3, '0');
        const filename = `page_${paddedPageNum}${ext}`;
        
        archive.append(Buffer.from(imageResponse.data), { name: filename });
        
        console.log(`✓ Added ${filename}`);
      } catch (imgError) {
        console.error(`Failed to download page ${page.page}:`, imgError.message);
      }
    }

    // Add a metadata file
    const metadata = {
      manga: chapterData.mangaId,
      chapter: chapterData.chapterId,
      title: chapterData.title,
      totalPages: chapterData.totalPages,
      downloadedAt: new Date().toISOString(),
      source: chapterData.url
    };
    
    archive.append(JSON.stringify(metadata, null, 2), { name: 'info.json' });

    // Finalize the archive
    await archive.finalize();
    console.log(`✓ ZIP created successfully: ${zipFilename}`);

  } catch (error) {
    console.error('Download error:', error.message);
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }
  }
});

// ULTRA-FAST: Parallel download with concurrency control
router.get('/api/download-multiple/chapters', async (req, res) => {
  let archive = null;
  
  try {
    const { chapters, folderName } = req.query;
    
    if (!chapters) {
      return res.status(400).json({
        success: false,
        error: 'Chapters parameter required. Use ?chapters=manga/chapter1,manga/chapter2'
      });
    }
    
    const chapterList = chapters.split(',').map(c => c.trim());
    
    console.log(`\n🚀 ULTRA-FAST MODE: ${chapterList.length} chapters`);
    console.log(`⚡ Estimated time: ~${Math.ceil(chapterList.length * 0.1)} minutes\n`);
    
    if (chapterList.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No chapters specified'
      });
    }

    // No timeout limits
    req.setTimeout(0);
    res.setTimeout(0);

    const zipFilename = folderName ? `${folderName}.zip` : 'manga_chapters.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');

    // Fast compression
    archive = archiver('zip', {
      zlib: { level: 1 }, // Minimal compression = maximum speed
      store: false
    });

    archive.on('error', (err) => {
      console.error('\n❌ ARCHIVE ERROR:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') {
        console.error('❌ Archive warning:', err);
      }
    });

    let totalBytes = 0;
    let lastLog = Date.now();
    
    archive.on('progress', (progress) => {
      totalBytes = progress.fs.processedBytes;
      if (Date.now() - lastLog > 3000) {
        console.log(`📊 ${(totalBytes / 1024 / 1024).toFixed(1)} MB | ${progress.entries.processed}/${progress.entries.total} files`);
        lastLog = Date.now();
      }
    });

    archive.pipe(res);

    const successfulChapters = [];
    const failedChapters = [];
    let totalPages = 0;

    // PARALLEL PROCESSING HELPER
    async function processChaptersBatch(batch, batchIndex) {
      const results = await Promise.allSettled(
        batch.map(async (chapterPath, indexInBatch) => {
          const globalIndex = batchIndex * BATCH_SIZE + indexInBatch;
          const startTime = Date.now();
          
          try {
            const url = `https://mangabuddy.com/${chapterPath}`;
            
            // Fetch chapter page
            const response = await fetchWithRetry(url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html',
                'Referer': 'https://mangabuddy.com/'
              },
              timeout: 20000
            }, 3);

            const $ = cheerio.load(response.data);
            const chapterTitle = $('h1').first().text().trim() || 'Chapter';

            // Extract images with actual page numbers
            const imageMap = new Map();
            
            $('img').each((i, elem) => {
              const $elem = $(elem);
              const src = $elem.attr('src') || $elem.attr('data-src') || $elem.attr('data-original');
              const alt = $elem.attr('alt') || '';
              
              if (src && src.includes('mbcdns')) {
                const pageMatch = alt.match(/Page\s+(\d+)/i);
                const pageNum = pageMatch ? parseInt(pageMatch[1]) : null;
                
                if (pageNum) {
                  imageMap.set(pageNum, src);
                } else {
                  if (!imageMap.has(src)) {
                    imageMap.set(`temp_${i}`, src);
                  }
                }
              }
            });

            const scriptImageUrls = [];
            $('script').each((i, elem) => {
              const scriptText = $(elem).html() || '';
              if (!scriptText) return;
              
              const regex = /https?:\/\/s\d+\.mbcdns[a-z]+\.org\/[^\s"',]+\.(?:jpg|jpeg|png|webp)/gi;
              const matches = scriptText.match(regex);
              
              if (matches) {
                matches.forEach(url => {
                  scriptImageUrls.push(url.replace(/[\\",;)\]]+$/, ''));
                });
              }
            });

            scriptImageUrls.forEach((url) => {
              let urlExists = false;
              for (let [key, value] of imageMap.entries()) {
                if (value === url) {
                  urlExists = true;
                  break;
                }
              }
              
              if (!urlExists) {
                let pageNum = 1;
                while (imageMap.has(pageNum)) {
                  pageNum++;
                }
                imageMap.set(pageNum, url);
              }
            });

            // Convert and sort
            let pages = [];
            const sortedEntries = Array.from(imageMap.entries())
              .filter(([key]) => typeof key === 'number')
              .sort((a, b) => a[0] - b[0]);

            sortedEntries.forEach(([pageNum, url]) => {
              pages.push({
                page: pageNum,
                imageUrl: url
              });
            });

            // Fallback
            if (pages.length === 0) {
              const allUrls = Array.from(new Set([...Array.from(imageMap.values()), ...scriptImageUrls]));
              
              pages = allUrls.map((url, index) => ({
                page: index + 1,
                imageUrl: url
              }));

              pages.sort((a, b) => {
                const aMatch = a.imageUrl.match(/s(\d+)\./);
                const bMatch = b.imageUrl.match(/s(\d+)\./);
                return (aMatch ? parseInt(aMatch[1]) : 0) - (bMatch ? parseInt(bMatch[1]) : 0);
              });

              pages.forEach((page, index) => page.page = index + 1);
            }

            if (pages.length === 0) {
              throw new Error('No images found');
            }

            const chapterFolder = chapterPath.replace(/\//g, '-');
            
            // PARALLEL IMAGE DOWNLOAD (10 at a time per chapter)
            const IMAGE_CONCURRENCY = 10;
            let downloadedCount = 0;
            
            for (let i = 0; i < pages.length; i += IMAGE_CONCURRENCY) {
              const imageBatch = pages.slice(i, i + IMAGE_CONCURRENCY);
              
              const imageResults = await Promise.allSettled(
                imageBatch.map(async (page) => {
                  const imgResponse = await fetchWithRetry(page.imageUrl, {
                    responseType: 'arraybuffer',
                    headers: {
                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                      'Referer': 'https://mangabuddy.com/',
                      'Accept': 'image/*'
                    },
                    timeout: 30000
                  }, 4);

                  const ext = path.extname(page.imageUrl).split('?')[0] || '.jpg';
                  const filename = `${chapterFolder}/page_${String(page.page).padStart(3, '0')}${ext}`;
                  
                  return {
                    buffer: Buffer.from(imgResponse.data),
                    filename: filename
                  };
                })
              );

              // Add successful images to archive
              imageResults.forEach(result => {
                if (result.status === 'fulfilled') {
                  archive.append(result.value.buffer, { name: result.value.filename });
                  downloadedCount++;
                }
              });
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`✅ [${globalIndex + 1}/${chapterList.length}] ${chapterPath} - ${downloadedCount}/${pages.length} pages (${elapsed}s)`);

            // Metadata
            const metadata = {
              chapterPath,
              title: chapterTitle,
              totalPages: pages.length,
              downloadedPages: downloadedCount,
              processingTime: `${elapsed}s`
            };
            
            archive.append(JSON.stringify(metadata, null, 2), { 
              name: `${chapterFolder}/info.json` 
            });

            return {
              success: true,
              chapterPath,
              pages: downloadedCount
            };

          } catch (error) {
            console.error(`❌ [${globalIndex + 1}/${chapterList.length}] ${chapterPath} - ${error.message}`);
            
            archive.append(JSON.stringify({
              chapterPath,
              error: error.message,
              timestamp: new Date().toISOString()
            }, null, 2), { 
              name: `ERRORS/${chapterPath.replace(/\//g, '-')}.json` 
            });

            return {
              success: false,
              chapterPath,
              error: error.message
            };
          }
        })
      );

      return results;
    }

    // PROCESS CHAPTERS IN BATCHES (5 chapters at a time)
    const BATCH_SIZE = 5;
    const totalBatches = Math.ceil(chapterList.length / BATCH_SIZE);
    
    console.log(`⚡ Processing ${BATCH_SIZE} chapters simultaneously\n`);

    for (let i = 0; i < chapterList.length; i += BATCH_SIZE) {
      const batch = chapterList.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      
      console.log(`\n📦 Batch ${batchNum}/${totalBatches} (Chapters ${i + 1}-${Math.min(i + BATCH_SIZE, chapterList.length)})`);
      
      const results = await processChaptersBatch(batch, Math.floor(i / BATCH_SIZE));
      
      results.forEach(result => {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            successfulChapters.push(result.value.chapterPath);
            totalPages += result.value.pages;
          } else {
            failedChapters.push(result.value);
          }
        }
      });

      // Small cooldown between batches
      if (i + BATCH_SIZE < chapterList.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Summary
    const summary = {
      downloadedAt: new Date().toISOString(),
      totalChapters: chapterList.length,
      successfulChapters: successfulChapters.length,
      failedChapters: failedChapters.length,
      totalPagesDownloaded: totalPages,
      processingMode: 'ULTRA-FAST (Parallel)',
      concurrency: {
        chaptersPerBatch: BATCH_SIZE,
        imagesPerChapter: 10
      },
      failed: failedChapters
    };
    
    archive.append(JSON.stringify(summary, null, 2), { name: 'DOWNLOAD_SUMMARY.json' });

    const readme = `Manga Bulk Download - ULTRA FAST MODE
========================================

Downloaded: ${new Date().toISOString()}
Total Chapters: ${chapterList.length}
Successful: ${successfulChapters.length}
Failed: ${failedChapters.length}
Total Pages: ${totalPages}

Processing Mode: Parallel (${BATCH_SIZE} chapters + 10 images simultaneously)

${failedChapters.length > 0 ? `
Failed Chapters:
${failedChapters.map(f => `- ${f.chapterPath}: ${f.error}`).join('\n')}
` : 'All chapters downloaded successfully! ✅'}
`;
    
    archive.append(readme, { name: 'README.txt' });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📦 Finalizing...`);
    console.log(`   ✅ Success: ${successfulChapters.length}/${chapterList.length}`);
    console.log(`   📄 Pages: ${totalPages}`);
    console.log(`   ❌ Failed: ${failedChapters.length}`);
    console.log(`${'='.repeat(60)}\n`);

    await archive.finalize();
    
    console.log(`✅ COMPLETE: ${zipFilename}`);
    console.log(`📊 Size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB\n`);

  } catch (error) {
    console.error('\n❌ CRITICAL ERROR:', error);
    
    if (archive) {
      try { archive.abort(); } catch (e) {}
    }
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// Image proxy endpoint - bypasses CORS
router.get('/api/image-proxy', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    if (!url.includes('mbcdns')) {
      return res.status(403).json({ error: 'Only MangaBuddy images allowed' });
    }

    console.log(`Proxying image: ${url}`);

    const response = await fetchWithRetry(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://mangabuddy.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      timeout: 30000
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });

    res.send(Buffer.from(response.data));

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch image',
      message: error.message,
      code: error.code
    });
  }
});

router.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

router.get('/', (req, res) => {
  res.json({
    message: 'MangaBuddy Scraper API v2.2 - Complete Chapters + Latest Updates',
    version: '2.2.0',
    features: [
      'Latest manga updates scraper',
      'Complete chapter list via AJAX API',
      'DNS fallback support',
      'Automatic retry with exponential backoff',
      'Enhanced error handling',
      'AniList integration',
      'Bulk chapter download'
    ],
    endpoints: {
      connectionTest: '/manga/mangabuddy/api/test-connection',
      health: '/manga/mangabuddy/api/health',
      latestManga: '/manga/mangabuddy/api/latest?page=1',
      debug: '/manga/mangabuddy/api/debug/:mangaId/:chapterId',
      scrapeChapter: '/manga/mangabuddy/api/scrape/chapter/:mangaId/:chapterId',
      downloadChapter: '/manga/mangabuddy/api/download/chapter/:mangaId/:chapterId',
      downloadMultiple: '/manga/mangabuddy/api/download-multiple/chapters?chapters=CHAPTER_PATHS&folderName=NAME',
      scrapeManga: '/manga/mangabuddy/api/scrape/manga/:mangaId (now fetches ALL chapters)',
      anilistSearch: '/manga/mangabuddy/api/anilist/search?title=MANGA_TITLE',
      anilistById: '/manga/mangabuddy/api/anilist/:anilistId (optional: ?slug=mangabuddy-slug)',
      imageProxy: '/manga/mangabuddy/api/image-proxy?url=IMAGE_URL'
    },
    examples: {
      latestManga: '/manga/mangabuddy/api/latest?page=1',
      scrapeWithAllChapters: '/manga/mangabuddy/api/scrape/manga/the-ultimate-of-all-ages',
      downloadChapter: '/manga/mangabuddy/api/download/chapter/sakamoto-days/chapter-238',
      downloadMultiple: '/manga/mangabuddy/api/download-multiple/chapters?chapters=sakamoto-days/chapter-238,sakamoto-days/chapter-237&folderName=Sakamoto-Days',
      anilistWithSlug: '/manga/mangabuddy/api/anilist/196521?slug=zombie-dad'
    },
    changelog: {
      v2_2_0: [
        'Added /api/latest endpoint to scrape latest manga updates',
        'Supports pagination with ?page=N query parameter',
        'Extracts title, thumbnail, latest chapter, views, ratings, genres, summary',
        'Returns structured data with pagination info',
        'Added latestChapterId and latestChapterUrl to latest manga results',
        'Improved /api/anilist/:anilistId to try multiple title variations',
        'Added optional ?slug parameter to manually specify MangaBuddy slug',
        'Fixed page numbering to extract actual page numbers from alt attributes',
        'Fixed thumbnail extraction to avoid placeholder images'
      ],
      v2_1_0: [
        'Added AJAX API integration for complete chapter lists',
        'Auto-detects manga internal ID from page',
        'Fetches all chapters (not just visible 100)',
        'Falls back to HTML parsing if API fails',
        'Includes dataSource field to show API vs HTML'
      ]
    }
  });
});

module.exports = router;