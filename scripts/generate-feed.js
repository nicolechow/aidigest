#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (daily at 6am UTC) to fetch content and publish
// feed-x.json, feed-podcasts.json, and feed-blogs.json.
//
// Deduplication: tracks previously seen tweet IDs, episode GUIDs, and article
// URLs in state-feed.json so content is never repeated across runs.
//
// Usage: node generate-feed.js [--tweets-only | --podcasts-only | --blogs-only]
// Env vars needed: X_BEARER_TOKEN, DEEPGRAM_API_KEY (for non-YouTube podcasts)
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const X_API_BASE = 'https://api.x.com/2';
// Some RSS hosts (notably Substack) block non-browser user agents from cloud IPs.
// Using a real Chrome UA avoids 403 errors in GitHub Actions.
const RSS_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days — podcasts publish weekly/biweekly, not daily
const BLOG_LOOKBACK_HOURS = 72;
const YOUTUBE_LOOKBACK_HOURS = 168; // 7 days — YouTube channels post infrequently
const MAX_TWEETS_PER_USER = 3;
const MAX_ARTICLES_PER_BLOG = 3;
const MAX_VIDEOS_PER_CHANNEL = 1;

// State file lives in the repo root so it gets committed by GitHub Actions
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

// Tracks which tweet IDs and video IDs we've already included in feeds
// so we never send the same content twice across runs.

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    // Ensure seenArticles exists for older state files
    if (!state.seenArticles) state.seenArticles = {};
    return state;
  } catch {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  }
}

async function saveState(state) {
  // Prune entries older than 7 days to prevent the file from growing forever
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenVideos)) {
    if (ts < cutoff) delete state.seenVideos[id];
  }
  for (const [id, ts] of Object.entries(state.seenArticles || {})) {
    if (ts < cutoff) delete state.seenArticles[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- Podcast Fetching (RSS + YouTube captions / Deepgram) --------------------

// Parses an RSS feed XML string and returns episode objects with
// title, publishedAt, guid, link, and enclosureUrl. RSS feeds list newest first.
function parseRssFeed(xml) {
  const episodes = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];

    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
      || block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

    const guidMatch = block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/)
      || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : null;

    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;

    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;

    // Audio file URL from <enclosure> tag — used for Deepgram transcription
    const enclosureMatch = block.match(/<enclosure[^>]*url="([^"]+)"[^>]*/i);
    const enclosureUrl = enclosureMatch ? enclosureMatch[1] : null;

    if (guid) {
      episodes.push({ title, guid, publishedAt, link, enclosureUrl });
    }
  }
  return episodes;
}

// Transcribes audio from a URL using Deepgram's pre-recorded API.
// Used for non-YouTube podcasts (e.g. 小宇宙) where we can't get captions.
async function fetchDeepgramTranscript(audioUrl, apiKey) {
  const res = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&detect_language=true',
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: audioUrl }),
      signal: AbortSignal.timeout(300000) // 5 min — podcast episodes can be long
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `Deepgram HTTP ${res.status}: ${text}` };
  }

  const data = await res.json();
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return transcript ? { transcript } : { error: 'No transcript in Deepgram response' };
}

// Main podcast fetching function. For each podcast:
// - YouTube podcasts (url contains youtube.com): resolve channel/playlist →
//   find latest video → fetch free native captions via fetchYouTubeTranscript
// - Non-YouTube podcasts (e.g. 小宇宙): fetch RSS audio URL → Deepgram
async function fetchPodcastContent(podcasts, deepgramKey, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const podcast of podcasts) {
    try {
      const isYouTube = podcast.url?.includes('youtube.com');

      if (isYouTube) {
        // YouTube path: resolve channel or playlist → YouTube RSS → captions (free)
        console.error(`  Processing YouTube podcast: ${podcast.name}...`);

        let ytRssUrl;
        const handleMatch = podcast.url.match(/@([^/?\s&]+)/);
        const playlistMatch = podcast.url.match(/[?&]list=([^&\s]+)/);

        if (handleMatch) {
          const channelId = await resolveYouTubeChannelId(handleMatch[1]);
          if (!channelId) {
            errors.push(`Podcast: Could not resolve YouTube channel for ${podcast.name}`);
            continue;
          }
          ytRssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        } else if (playlistMatch) {
          ytRssUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistMatch[1]}`;
        } else {
          errors.push(`Podcast: Cannot determine YouTube channel/playlist for ${podcast.name}`);
          continue;
        }

        const rssRes = await fetch(ytRssUrl, {
          headers: { 'User-Agent': RSS_USER_AGENT },
          signal: AbortSignal.timeout(15000)
        });
        if (!rssRes.ok) {
          errors.push(`Podcast: YouTube RSS fetch failed for ${podcast.name}: HTTP ${rssRes.status}`);
          continue;
        }

        const videos = parseYouTubeRss(await rssRes.text());
        const newVideos = videos
          .filter(v => !state.seenVideos[v.videoId])
          .filter(v => !v.publishedAt || new Date(v.publishedAt) >= cutoff)
          .slice(0, 1);

        for (const video of newVideos) {
          console.error(`    Fetching captions for "${video.title}"...`);
          const transcript = await fetchYouTubeTranscript(video.videoId);
          state.seenVideos[video.videoId] = Date.now();

          if (!transcript) {
            console.error(`    No captions available — skipping`);
            errors.push(`Podcast: No captions for "${video.title}" (${podcast.name})`);
            continue;
          }

          console.error(`    Got transcript (${transcript.length} chars)`);
          results.push({
            source: 'podcast',
            name: podcast.name,
            title: video.title,
            guid: video.videoId,
            url: `https://www.youtube.com/watch?v=${video.videoId}`,
            publishedAt: video.publishedAt,
            transcript
          });
        }
      } else {
        // Non-YouTube path (e.g. 小宇宙): RSS audio URL → Deepgram transcription
        if (!podcast.rssUrl) {
          errors.push(`Podcast: No rssUrl configured for ${podcast.name}`);
          continue;
        }

        console.error(`  Fetching RSS for ${podcast.name}...`);
        const rssRes = await fetch(podcast.rssUrl, {
          headers: {
            'User-Agent': RSS_USER_AGENT,
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          },
          signal: AbortSignal.timeout(30000)
        });

        if (!rssRes.ok) {
          errors.push(`Podcast: Failed to fetch RSS for ${podcast.name}: HTTP ${rssRes.status}`);
          continue;
        }

        const episodes = parseRssFeed(await rssRes.text());
        console.error(`  ${podcast.name}: found ${episodes.length} episodes`);

        const candidates = episodes
          .slice(0, 3)
          .filter(ep => !state.seenVideos[ep.guid])
          .filter(ep => !ep.publishedAt || new Date(ep.publishedAt) >= cutoff);

        for (const episode of candidates) {
          state.seenVideos[episode.guid] = Date.now();

          if (!episode.enclosureUrl) {
            errors.push(`Podcast: No audio URL in RSS for "${episode.title}" (${podcast.name})`);
            continue;
          }

          console.error(`    Transcribing "${episode.title}" via Deepgram...`);
          const result = await fetchDeepgramTranscript(episode.enclosureUrl, deepgramKey);

          if (result.error) {
            console.error(`    Deepgram error: ${result.error}`);
            errors.push(`Podcast: Deepgram error for "${episode.title}": ${result.error}`);
            continue;
          }

          console.error(`    Got transcript (${result.transcript.length} chars)`);
          results.push({
            source: 'podcast',
            name: podcast.name,
            title: episode.title,
            guid: episode.guid,
            url: episode.link || podcast.url,
            publishedAt: episode.publishedAt,
            transcript: result.transcript
          });
          break; // one episode per podcast per run
        }
      }
    } catch (err) {
      errors.push(`Podcast: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  return results;
}

// -- X/Twitter Fetching (Official API v2) ------------------------------------

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Batch lookup all user IDs (1 API call)
  const handles = xAccounts.map(a => a.handle);
  let userMap = {};

  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(
        `${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        errors.push(`X API: User lookup failed: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || ''
        };
      }
      if (data.errors) {
        for (const err of data.errors) {
          errors.push(`X API: User not found: ${err.value || err.detail}`);
        }
      }
    } catch (err) {
      errors.push(`X API: User lookup error: ${err.message}`);
    }
  }

  // Fetch recent tweets per user (max 3, exclude retweets/replies)
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetch(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
        `max_results=5` +       // fetch 5, then filter to 3 new ones
        `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
        `&exclude=retweets,replies` +
        `&start_time=${cutoff.toISOString()}`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        if (res.status === 429) {
          errors.push(`X API: Rate limited, skipping remaining accounts`);
          break;
        }
        errors.push(`X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const allTweets = data.data || [];

      // Filter out already-seen tweets, cap at 3
      const newTweets = [];
      for (const t of allTweets) {
        if (state.seenTweets[t.id]) continue; // dedup
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          // note_tweet.text has the full untruncated text for long tweets (>280 chars)
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false,
          quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null
        });

        // Mark as seen
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: 'x',
        name: account.name,
        handle: account.handle,
        bio: userData.description,
        tweets: newTweets
      });

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- Blog Fetching (HTML scraping) -------------------------------------------

// Scrapes the Anthropic Engineering blog index page.
// The page is a Next.js app that embeds article data as JSON in <script> tags.
// We parse that JSON to extract article metadata (title, slug, date, summary).
// Falls back to regex-based HTML parsing if the JSON approach fails.
function parseAnthropicEngineeringIndex(html) {
  const articles = [];

  // Strategy 1: Look for article data in Next.js __NEXT_DATA__ script tag
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      // Navigate the Next.js page props to find article entries
      const pageProps = data?.props?.pageProps;
      const posts = pageProps?.posts || pageProps?.articles || pageProps?.entries || [];
      for (const post of posts) {
        const slug = post.slug?.current || post.slug || '';
        articles.push({
          title: post.title || 'Untitled',
          url: `https://www.anthropic.com/engineering/${slug}`,
          publishedAt: post.publishedOn || post.publishedAt || post.date || null,
          description: post.summary || post.description || ''
        });
      }
      if (articles.length > 0) return articles;
    } catch {
      // JSON parsing failed, fall through to regex approach
    }
  }

  // Strategy 2: Regex-based extraction from the rendered HTML.
  // Anthropic engineering articles follow the pattern /engineering/<slug>
  const linkRegex = /href="\/engineering\/([a-z0-9-]+)"/gi;
  const seenSlugs = new Set();
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: '', // Will be filled when we fetch the article page
      url: `https://www.anthropic.com/engineering/${slug}`,
      publishedAt: null,
      description: ''
    });
  }
  return articles;
}

// Scrapes the Claude Blog index page (claude.com/blog).
// This is a Webflow site. We extract article links, titles, and dates
// from the HTML structure.
function parseClaudeBlogIndex(html) {
  const articles = [];
  const seenSlugs = new Set();

  // Match blog post links — they follow the pattern /blog/<slug>
  // We capture surrounding context to extract titles and dates
  const linkRegex = /href="\/blog\/([a-z0-9-]+)"/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: '', // Will be filled when we fetch the article page
      url: `https://claude.com/blog/${slug}`,
      publishedAt: null,
      description: ''
    });
  }
  return articles;
}

// Extracts the main text content from an Anthropic Engineering article page.
// Tries the embedded JSON first (Next.js SSR data), then falls back to
// stripping HTML tags from the article body.
function extractAnthropicArticleContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  // Try to get structured data from Next.js __NEXT_DATA__
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const pageProps = data?.props?.pageProps;
      const post = pageProps?.post || pageProps?.article || pageProps?.entry || pageProps;
      title = post?.title || '';
      author = post?.author?.name || post?.authors?.[0]?.name || '';
      publishedAt = post?.publishedOn || post?.publishedAt || post?.date || null;

      // Extract text from the body blocks (Sanity CMS portable text format)
      const body = post?.body || post?.content || [];
      if (Array.isArray(body)) {
        const textParts = [];
        for (const block of body) {
          if (block._type === 'block' && block.children) {
            const text = block.children.map(c => c.text || '').join('');
            if (text.trim()) textParts.push(text.trim());
          }
        }
        content = textParts.join('\n\n');
      }
      if (content) return { title, author, publishedAt, content };
    } catch {
      // Fall through to HTML stripping
    }
  }

  // Fallback: extract title from <h1> and body from <article> or main content
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();

  // Try to find the article body and strip HTML tags
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyHtml = articleMatch ? articleMatch[1] : html;

  // Strip script/style tags first, then all remaining HTML tags
  content = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, author, publishedAt, content };
}

// Extracts the main text content from a Claude Blog article page.
// Uses JSON-LD schema data if present, then falls back to the rich text body.
function extractClaudeBlogArticleContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  // Try JSON-LD structured data first (most reliable for metadata)
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld['@type'] === 'BlogPosting' || ld['@type'] === 'Article') {
        title = ld.headline || ld.name || '';
        author = ld.author?.name || '';
        publishedAt = ld.datePublished || null;
        break;
      }
    } catch {
      // Not valid JSON-LD, skip
    }
  }

  // Extract body text from the Webflow rich text container
  const richTextMatch = html.match(/<div[^>]*class="[^"]*u-rich-text-blog[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (richTextMatch) {
    content = richTextMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // If rich text extraction failed, try a broader approach
  if (!content) {
    // Get title from <h1> if not already found
    if (!title) {
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
    }

    // Strip the whole page down to text as a last resort
    content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { title, author, publishedAt, content };
}

// Main blog fetching orchestrator.
// For each blog source in the config, discovers new articles, deduplicates
// against previously seen URLs, fetches full article content, and returns
// the results for feed-blogs.json.
async function fetchBlogContent(blogs, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const blog of blogs) {
    console.error(`  Processing blog: ${blog.name}...`);
    let candidates = [];

    try {
      // Step 1: Discover articles from the blog index page
      const indexRes = await fetch(blog.indexUrl, {
        headers: { 'User-Agent': 'FollowBuilders/1.0 (feed aggregator)' }
      });
      if (!indexRes.ok) {
        errors.push(`Blog: Failed to fetch index for ${blog.name}: HTTP ${indexRes.status}`);
        continue;
      }
      const indexHtml = await indexRes.text();

      // Use the right parser based on which blog this is
      if (blog.indexUrl.includes('anthropic.com')) {
        candidates = parseAnthropicEngineeringIndex(indexHtml);
      } else if (blog.indexUrl.includes('claude.com')) {
        candidates = parseClaudeBlogIndex(indexHtml);
      }

      // Step 2: Filter to unseen articles, cap at MAX_ARTICLES_PER_BLOG.
      // Blog index pages list articles newest-first. We only consider the
      // first few entries (MAX_INDEX_SCAN) to avoid crawling the entire
      // backlog on first run. Articles with a known date must fall within
      // the lookback window; articles without dates are accepted if they
      // appear near the top of the listing (likely recent).
      const MAX_INDEX_SCAN = MAX_ARTICLES_PER_BLOG; // only look at the N most recent entries
      const newArticles = [];
      for (const article of candidates.slice(0, MAX_INDEX_SCAN)) {
        if (state.seenArticles[article.url]) continue; // already seen
        // If we have a date, check it's within the lookback window
        if (article.publishedAt && new Date(article.publishedAt) < cutoff) continue;
        newArticles.push(article);
        if (newArticles.length >= MAX_ARTICLES_PER_BLOG) break;
      }

      if (newArticles.length === 0) {
        console.error(`    No new articles found`);
        continue;
      }

      console.error(`    Found ${newArticles.length} new article(s), fetching content...`);

      // Step 3: Fetch full article content for each new article
      for (const article of newArticles) {
        try {
          // Fetch the full article page
          const articleRes = await fetch(article.url, {
            headers: { 'User-Agent': 'FollowBuilders/1.0 (feed aggregator)' }
          });
          if (!articleRes.ok) {
            errors.push(`Blog: Failed to fetch article ${article.url}: HTTP ${articleRes.status}`);
            continue;
          }
          const articleHtml = await articleRes.text();

          // Use the right content extractor based on the blog
          let extracted;
          if (article.url.includes('anthropic.com/engineering')) {
            extracted = extractAnthropicArticleContent(articleHtml);
          } else if (article.url.includes('claude.com/blog')) {
            extracted = extractClaudeBlogArticleContent(articleHtml);
          }

          if (!extracted || !extracted.content) {
            errors.push(`Blog: No content extracted from ${article.url}`);
            continue;
          }

          // Merge extracted data with what we already have from the index
          results.push({
            source: 'blog',
            name: blog.name,
            title: extracted.title || article.title || 'Untitled',
            url: article.url,
            publishedAt: extracted.publishedAt || article.publishedAt || null,
            author: extracted.author || '',
            description: article.description || '',
            content: extracted.content
          });

          // Mark as seen
          state.seenArticles[article.url] = Date.now();

          // Small delay between article fetches to be polite
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          errors.push(`Blog: Error fetching article ${article.url}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`Blog: Error processing ${blog.name}: ${err.message}`);
    }
  }

  return results;
}

// -- YouTube Fetching (channel RSS + native captions) ------------------------

// Parses a YouTube Atom feed (videos.xml) and returns video metadata.
function parseYouTubeRss(xml) {
  const videos = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];
    const videoIdMatch = block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/);
    const videoId = videoIdMatch ? videoIdMatch[1].trim() : null;
    const title = titleMatch
      ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
      : 'Untitled';
    const publishedAt = publishedMatch ? new Date(publishedMatch[1].trim()).toISOString() : null;
    if (videoId) videos.push({ videoId, title, publishedAt });
  }
  return videos;
}

// Resolves a YouTube channel ID from a @handle by fetching the channel page.
async function resolveYouTubeChannelId(handle) {
  try {
    const res = await fetch(`https://www.youtube.com/@${handle}`, {
      headers: { 'User-Agent': RSS_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/)
      || html.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Fetches a YouTube video's auto-generated captions without any API key.
// Parses the native caption track from the video page's embedded JSON.
async function fetchYouTubeTranscript(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': RSS_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Extract caption track list from the embedded player response
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*(?:;|<\/script>)/);
    if (!playerMatch) return null;

    const data = JSON.parse(playerMatch[1]);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return null;

    // Prefer English; fall back to first available track
    const track = tracks.find(t => t.languageCode === 'en')
      || tracks.find(t => t.languageCode?.startsWith('en'))
      || tracks[0];

    // Fetch the caption XML and join segments into plain text
    const captionRes = await fetch(track.baseUrl, { signal: AbortSignal.timeout(15000) });
    if (!captionRes.ok) return null;
    const captionXml = await captionRes.text();

    const segments = [];
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = textRegex.exec(captionXml)) !== null) {
      const text = m[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\n/g, ' ').trim();
      if (text) segments.push(text);
    }
    return segments.length > 0 ? segments.join(' ') : null;
  } catch {
    return null;
  }
}

// Main YouTube fetching function. For each channel:
// 1. Resolves the channel ID from the @handle
// 2. Fetches the YouTube RSS feed to discover recent videos
// 3. Filters by lookback window and dedup
// 4. Fetches auto-generated captions for new videos
async function fetchYouTubeContent(youtubeChannels, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - YOUTUBE_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const channel of youtubeChannels) {
    try {
      console.error(`  Processing YouTube channel: ${channel.name}...`);

      // Resolve channel ID (cached in config as channelId, or derive from handle)
      let channelId = channel.channelId;
      if (!channelId) {
        channelId = await resolveYouTubeChannelId(channel.handle);
        if (!channelId) {
          errors.push(`YouTube: Could not resolve channel ID for ${channel.name} (@${channel.handle})`);
          continue;
        }
        console.error(`    Resolved channel ID: ${channelId}`);
      }

      // Fetch YouTube's Atom RSS feed for the channel
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
      const rssRes = await fetch(rssUrl, {
        headers: { 'User-Agent': RSS_USER_AGENT },
        signal: AbortSignal.timeout(15000)
      });
      if (!rssRes.ok) {
        errors.push(`YouTube: RSS fetch failed for ${channel.name}: HTTP ${rssRes.status}`);
        continue;
      }

      const videos = parseYouTubeRss(await rssRes.text());
      console.error(`    Found ${videos.length} videos in RSS feed`);

      // Filter: within lookback window, not already seen
      const newVideos = videos
        .filter(v => !state.seenVideos[v.videoId])
        .filter(v => !v.publishedAt || new Date(v.publishedAt) >= cutoff)
        .slice(0, MAX_VIDEOS_PER_CHANNEL);

      for (const video of newVideos) {
        console.error(`    Fetching transcript for "${video.title}"...`);
        const transcript = await fetchYouTubeTranscript(video.videoId);

        // Mark as seen so we don't retry videos that had no captions
        state.seenVideos[video.videoId] = Date.now();

        if (!transcript) {
          console.error(`    No captions available — skipping`);
          errors.push(`YouTube: No captions for "${video.title}" (${video.videoId})`);
          continue;
        }

        console.error(`    Got transcript (${transcript.length} chars)`);
        results.push({
          source: 'youtube',
          name: channel.name,
          handle: channel.handle,
          title: video.title,
          videoId: video.videoId,
          url: `https://www.youtube.com/watch?v=${video.videoId}`,
          publishedAt: video.publishedAt,
          transcript
        });
      }
    } catch (err) {
      errors.push(`YouTube: Error processing ${channel.name}: ${err.message}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');
  const blogsOnly = args.includes('--blogs-only');
  const youtubeOnly = args.includes('--youtube-only');

  const anyOnly = tweetsOnly || podcastsOnly || blogsOnly || youtubeOnly;
  const runTweets = tweetsOnly || !anyOnly;
  const runPodcasts = podcastsOnly || !anyOnly;
  const runBlogs = blogsOnly || !anyOnly;
  const runYouTube = youtubeOnly || !anyOnly;

  const xBearerToken = process.env.X_BEARER_TOKEN;
  const deepgramKey = process.env.DEEPGRAM_API_KEY;

  if (runTweets && !xBearerToken) {
    console.error('X_BEARER_TOKEN not set');
    process.exit(1);
  }
  // Podcasts: YouTube channels use free native captions; DEEPGRAM_API_KEY is only
  // required for non-YouTube sources (e.g. 小宇宙). Missing key skips those podcasts.

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets
  if (runTweets) {
    console.error('Fetching X/Twitter content...');
    const xContent = await fetchXContent(sources.x_accounts, xBearerToken, state, errors);
    console.error(`  Found ${xContent.length} builders with new tweets`);

    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      x: xContent,
      stats: { xBuilders: xContent.length, totalTweets },
      errors: errors.filter(e => e.startsWith('X API')).length > 0
        ? errors.filter(e => e.startsWith('X API')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
    console.error(`  feed-x.json: ${xContent.length} builders, ${totalTweets} tweets`);
  }

  // Fetch podcasts
  if (runPodcasts) {
    console.error('Fetching podcast content...');
    const podcasts = await fetchPodcastContent(sources.podcasts, deepgramKey, state, errors);
    console.error(`  Found ${podcasts.length} new episodes`);

    const podcastFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: PODCAST_LOOKBACK_HOURS,
      podcasts,
      stats: { podcastEpisodes: podcasts.length },
      errors: errors.filter(e => e.startsWith('Podcast')).length > 0
        ? errors.filter(e => e.startsWith('Podcast')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(podcastFeed, null, 2));
    console.error(`  feed-podcasts.json: ${podcasts.length} episodes`);
  }

  // Fetch blog posts
  if (runBlogs && sources.blogs && sources.blogs.length > 0) {
    console.error('Fetching blog content...');
    const blogContent = await fetchBlogContent(sources.blogs, state, errors);
    console.error(`  Found ${blogContent.length} new blog post(s)`);

    const blogFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: BLOG_LOOKBACK_HOURS,
      blogs: blogContent,
      stats: { blogPosts: blogContent.length },
      errors: errors.filter(e => e.startsWith('Blog')).length > 0
        ? errors.filter(e => e.startsWith('Blog')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-blogs.json'), JSON.stringify(blogFeed, null, 2));
    console.error(`  feed-blogs.json: ${blogContent.length} posts`);
  }

  // Fetch YouTube videos
  if (runYouTube && sources.youtube_channels && sources.youtube_channels.length > 0) {
    console.error('Fetching YouTube content...');
    const youtubeContent = await fetchYouTubeContent(sources.youtube_channels, state, errors);
    console.error(`  Found ${youtubeContent.length} new video(s)`);

    const youtubeFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: YOUTUBE_LOOKBACK_HOURS,
      youtube: youtubeContent,
      stats: { youtubeVideos: youtubeContent.length },
      errors: errors.filter(e => e.startsWith('YouTube')).length > 0
        ? errors.filter(e => e.startsWith('YouTube')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-youtube.json'), JSON.stringify(youtubeFeed, null, 2));
    console.error(`  feed-youtube.json: ${youtubeContent.length} videos`);
  }

  // Save dedup state
  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors`);
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});
