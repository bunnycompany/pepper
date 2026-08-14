import { fetchText, fetchJSON } from '../fetchx.js';
import { parseFeed } from './rss.js';

// The papers lens. Primary: Firecrawl's Research Index — keyless, relevance-
// ranked, covers arXiv + PubMed/bioRxiv/medRxiv, and doesn't rate-limit the
// way arXiv's API does. Fallback: the classic arXiv Atom API, throttled to
// one call per 3.5s with a cooldown after any failure (arXiv 429s bursts).
// fetchTopic(query) → Item[] (without id/topic/seenAt); [] on any failure.

const FC_URL = 'https://api.firecrawl.dev/v2/search/research/papers';

function sourceFor(primaryId) {
  const p = String(primaryId || '');
  if (p.startsWith('arxiv:')) return 'arXiv';
  if (p.startsWith('pmid:') || p.startsWith('pmcid:')) return 'PubMed';
  if (p.startsWith('doi:')) return 'DOI';
  return 'Research Index';
}

function urlFor(primaryId, ids) {
  const p = String(primaryId || '');
  if (p.startsWith('arxiv:')) return 'https://arxiv.org/abs/' + p.slice(6);
  if (p.startsWith('pmid:')) return 'https://pubmed.ncbi.nlm.nih.gov/' + p.slice(5) + '/';
  if (p.startsWith('doi:')) return 'https://doi.org/' + p.slice(4);
  const ax = ids && Array.isArray(ids.arxiv) && ids.arxiv[0];
  return ax ? 'https://arxiv.org/abs/' + ax : '';
}

async function viaResearchIndex(query) {
  const data = await fetchJSON(
    FC_URL + '?query=' + encodeURIComponent(String(query ?? '')) + '&k=6',
  );
  if (!data || data.success === false || !Array.isArray(data.results)) return null;
  const items = [];
  for (const p of data.results.slice(0, 6)) {
    if (!p || !p.title) continue;
    items.push({
      title: String(p.title).replace(/\s+/g, ' ').trim(),
      url: urlFor(p.primaryId, p.ids),
      source: sourceFor(p.primaryId),
      lens: 'arxiv',
      publishedAt: null,
      snippet: String(p.abstract || '').replace(/\s+/g, ' ').slice(0, 200).trim(),
    });
  }
  return items;
}

let lastArxivCall = 0;
let arxivCooldownUntil = 0;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

async function viaArxivApi(query) {
  const now = Date.now();
  if (now < arxivCooldownUntil) return [];
  const wait = 3500 - (now - lastArxivCall);
  if (wait > 0) await sleep(wait);
  lastArxivCall = Date.now();
  const url = 'https://export.arxiv.org/api/query?search_query=all:%22'
    + encodeURIComponent(String(query ?? ''))
    + '%22&sortBy=submittedDate&sortOrder=descending&max_results=6';
  const xml = await fetchText(url);
  if (!xml) {
    // Any failure (429s included) → back off for 10 minutes.
    arxivCooldownUntil = Date.now() + 10 * 60_000;
    return [];
  }
  const items = [];
  for (const e of parseFeed(xml)) {
    if (!e.title) continue;
    items.push({
      title: e.title,
      url: e.url || '',
      source: 'arXiv',
      lens: 'arxiv',
      publishedAt: e.publishedAt || null,
      snippet: String(e.snippet || '').slice(0, 200).trim(),
    });
  }
  return items;
}

export async function fetchTopic(query) {
  try {
    const primary = await viaResearchIndex(query);
    if (primary && primary.length) return primary;
    return await viaArxivApi(query);
  } catch {
    return [];
  }
}
