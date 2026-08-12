import { fetchJSON } from '../fetchx.js';

function toIso(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// fetchTopic(query) → Item[] (without id/topic/seenAt); [] on any failure.
export async function fetchTopic(query) {
  try {
    const url = 'https://hn.algolia.com/api/v1/search_by_date?query='
      + encodeURIComponent(String(query ?? '')) + '&tags=story&hitsPerPage=10';
    const data = await fetchJSON(url);
    const hits = data && Array.isArray(data.hits) ? data.hits : [];
    const items = [];
    for (const h of hits) {
      if (!h) continue;
      const title = String(h.title || h.story_title || '').trim();
      if (!title) continue;
      const id = h.objectID || h.story_id || '';
      items.push({
        title,
        url: h.url || (id ? 'https://news.ycombinator.com/item?id=' + id : ''),
        source: 'Hacker News',
        lens: 'hn',
        publishedAt: toIso(h.created_at),
        points: Number(h.points) || 0,
      });
    }
    return items;
  } catch {
    return [];
  }
}
