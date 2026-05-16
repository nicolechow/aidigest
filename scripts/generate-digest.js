#!/usr/bin/env node

// ============================================================================
// Nicole's AI Digest — Digest Generator
// ============================================================================
// Reads local feed JSON files, loads prompts, calls the Claude API to remix
// the content into a digest, and outputs the digest text to stdout.
//
// Designed to run in GitHub Actions after generate-feed.js has committed
// the feed files. Pipe stdout to deliver.js to send to Telegram.
//
// Usage: node generate-digest.js | node deliver.js
// Env:   ANTHROPIC_API_KEY
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Anthropic from '@anthropic-ai/sdk';

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const REPO_ROOT = join(SCRIPT_DIR, '..');

async function loadFeed(filename) {
  const path = join(REPO_ROOT, filename);
  if (!existsSync(path)) return null;
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
}

async function loadPrompt(filename) {
  const path = join(REPO_ROOT, 'prompts', filename);
  if (!existsSync(path)) return '';
  return readFile(path, 'utf-8');
}

async function main() {
  // Load all feed files (written by generate-feed.js in the same repo)
  const [feedX, feedPodcasts, feedBlogs, feedYouTube] = await Promise.all([
    loadFeed('feed-x.json'),
    loadFeed('feed-podcasts.json'),
    loadFeed('feed-blogs.json'),
    loadFeed('feed-youtube.json'),
  ]);

  // Load prompts from the local prompts/ directory
  const promptFiles = [
    'digest-intro.md',
    'summarize-tweets.md',
    'summarize-podcast.md',
    'summarize-blogs.md',
    'summarize-youtube.md',
    'translate.md',
  ];
  const prompts = {};
  for (const f of promptFiles) {
    prompts[f.replace('.md', '').replace(/-/g, '_')] = await loadPrompt(f);
  }

  // Read user config for language preference (falls back to English)
  const configPath = join(homedir(), '.follow-builders', 'config.json');
  let config = { language: 'en', delivery: { method: 'stdout' } };
  if (existsSync(configPath)) {
    try { config = JSON.parse(await readFile(configPath, 'utf-8')); } catch {}
  }

  // Assemble the same JSON structure that prepare-digest.js produces
  const input = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    config: {
      language: config.language || 'en',
      delivery: config.delivery || { method: 'stdout' },
    },
    podcasts: feedPodcasts?.podcasts || [],
    x: feedX?.x || [],
    blogs: feedBlogs?.blogs || [],
    youtube: feedYouTube?.youtube || [],
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      youtubeVideos: feedYouTube?.youtube?.length || 0,
    },
    prompts,
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('ANTHROPIC_API_KEY not set\n');
    process.exit(1);
  }

  const client = new Anthropic();

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    system: 'You are an AI digest writer. Read the JSON input containing feed data and prompts, then follow the prompts to generate the digest. Output only the final digest text — no preamble, no JSON, just the digest.',
    messages: [{ role: 'user', content: JSON.stringify(input) }],
  });

  console.log(response.content[0].text);
}

main().catch(err => {
  process.stderr.write(`Digest generation failed: ${err.message}\n`);
  process.exit(1);
});
