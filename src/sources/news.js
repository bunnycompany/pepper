import { fetchText } from '../fetchx.js';
import { parseFeed } from './rss.js';

const MAX_ITEMS = 12;

// Google News titles look like "Headline - Publisher". When the feed's
// <source> tag is present, strip a matching trailing suffix from the title;
// when it's absent, split the trailing " - Publisher" into `source`.
function splitTitle(rawTitle, tagSource) {
  const title = String(rawTitle || '').trim();
  if (tagSource) {
    const suffix = ' - ' + tagSource;
    if (title.toLowerCase().endsWith(suffix.toLowerCase())) {
      return { title: title.slice(0, -suffix.length).trim(), source: tagSource };
    }
    return { title, source: tagSource };
  }
  const i = title.lastIndexOf(' - ');
  if (i > 0 && title.length - i - 3 > 0 && title.length - i - 3 <= 48) {
    return { title: title.slice(0, i).trim(), source: title.slice(i + 3).trim() };
  }
  return { title, source: '' };
}

// fetchTopic(query) → Item[] (without id/topic/seenAt); [] on any failure.
export async function fetchTopic(query) {
  try {
    const url = 'https://news.google.com/rss/search?q='
      + encodeURIComponent(String(query ?? '')) + '&hl=en-US&gl=US&ceid=US:en';
    const xml = await fetchText(url);
    if (!xml) return [];
    const items = [];
    for (const e of parseFeed(xml)) {
      const { title, source } = splitTitle(e.title, e.source);
      if (!title) continue;
      const item = {
        title,
        url: e.url || '',
        source: source || 'Google News',
        lens: 'news',
        publishedAt: e.publishedAt || null,
      };
      const snip = String(e.snippet || '').slice(0, 240).trim();
      if (snip && snip !== title) item.snippet = snip;
      items.push(item);
      if (items.length >= MAX_ITEMS) break;
    }
    return items;
  } catch {
    return [];
  }
}
