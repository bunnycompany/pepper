import { fetchText } from '../fetchx.js';
import { parseFeed } from './rss.js';

// fetchTopic(query) → Item[] (without id/topic/seenAt); [] on any failure.
export async function fetchTopic(query) {
  try {
    const url = 'https://export.arxiv.org/api/query?search_query=all:%22'
      + encodeURIComponent(String(query ?? ''))
      + '%22&sortBy=submittedDate&sortOrder=descending&max_results=6';
    const xml = await fetchText(url);
    if (!xml) return [];
    const items = [];
    for (const e of parseFeed(xml)) {
      if (!e.title) continue;
      items.push({
        title: e.title, // parseFeed already collapses whitespace
        url: e.url || '',
        source: 'arXiv',
        lens: 'arxiv',
        publishedAt: e.publishedAt || null,
        snippet: String(e.snippet || '').slice(0, 200).trim(),
      });
    }
    return items;
  } catch {
    return [];
  }
}
