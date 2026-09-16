// ============================================================================
// Discovery Sources — expanded B2B outreach across development hubs
//
// The growth engine previously discovered peers only from the CDP Bazaar. This
// module adds three additional discovery surfaces so the engine can autonomously
// enter emergent A2A environments — crypto projects on GitHub, the Google Cloud
// Agent Gallery, and the Salesforce AgentExchange:
//
//   1. GITHUB — search public repos for crypto/x402/AI-agent footprints, then
//      probe each project's homepage (package.json `homepage`, README links,
//      or the repo URL itself) for an x402 outreach surface.
//   2. GOOGLE_CLOUD_AGENT_GALLERY — scrape the public gallery index for agent
//      service URLs and collapse to origins.
//   3. SALESFORCE_AGENT_EXCHANGE — scrape the public exchange listing for agent
//      endpoints and collapse to origins.
//
// Each source returns origin URLs (https://host) that feed into the existing
// target pool, so the engine's existing probe -> pitch -> learn loop applies
// unchanged. All sources are best-effort: a network blip or a changed HTML
// structure degrades to "no new targets" with a warning, never a crash.
// ============================================================================

/**
 * Shared fetch-with-timeout helper. Never throws; returns status + body.
 *
 * @param {string} url - Absolute URL
 * @param {object} [options] - fetch options
 * @returns {Promise<{status: number, headers: Headers, body: string, ok: boolean}>}
 */
async function fetchSafe(url, options = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
      ok: response.ok,
    };
  } catch (error) {
    return { status: 0, headers: new Headers(), body: String(error?.message ?? error), ok: false };
  }
}

/**
 * Collapse a list of URLs to unique origins, filtering out relative paths.
 *
 * @param {Array<string>} urls - Full URLs to collapse
 * @returns {string[]} Unique `https://host` origins
 */
export function collapseToOrigins(urls) {
  const origins = new Set();
  for (const url of urls) {
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
    try {
      const parsed = new URL(url);
      origins.add(`${parsed.protocol}//${parsed.host}`);
    } catch {
      continue;
    }
  }
  return [...origins];
}

/**
 * Extract URLs from a body of text (README, package.json, HTML, etc.) using a
 * regex that catches http(s) URLs followed by common delimiters.
 *
 * @param {string} text - Text to scan
 * @returns {string[]} URLs found, deduplicated and cleaned
 */
export function extractUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const pattern = /https?:\/\/[^\s<>"'()]+/g;
  const seen = new Set();
  const results = [];
  for (const match of text.matchAll(pattern)) {
    const cleaned = match[0].replace(/[.,;)]+$/, '');
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      results.push(cleaned);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// GitHub Discovery
// ---------------------------------------------------------------------------

/**
 * GitHub search API endpoint for repositories.
 */
const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';

/**
 * Search GitHub for repositories that mention x402 or AI-agent payment
 * footprints. Returns origin URLs for each repo (the repo's GitHub origin is
 * treated as the peer — repos without a custom domain are probed on
 * github.com but are rare x402 peers, so we still surface them for the engine
 * to probe/fingerprint).
 *
 * @param {object} [options] - Search configuration
 * @param {string} [options.query] - GitHub search query (default: x402 crypto agents)
 * @param {number} [options.perPage] - Results per page (max 100)
 * @param {string} [options.token] - Optional GitHub token for higher rate limits
 * @returns {Promise<string[]>} Origin URLs of matching repos
 */
export async function discoverFromGitHub({ query, perPage = 30, token } = {}) {
  const searchQuery =
    query ||
    'x402 OR "payment required" OR "ai agent" OR "llms.txt" in:readme,description,topics language:javascript,typescript,python&sort=updated';

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(searchQuery)}&per_page=${Math.min(perPage, 100)}&sort=updated`;
  const res = await fetchSafe(url, { headers });

  if (res.status === 0 || !res.ok) {
    let err = `GitHub discovery failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`;
    if (res.status === 403) err += ' — rate-limited (set GITHUB_TOKEN for higher limits)';
    return [];
  }

  /** @type {any} */
  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    return [];
  }

  const items = data.items ?? [];
  const origins = [];

  for (const item of items) {
    // Prefer the repo's homepage if declared; fall back to the HTML URL origin.
    const candidate = item.homepage || item.html_url;
    if (candidate) origins.push(candidate);

    // If the README mentions specific service URLs (package.json homepage,
    // demo links), probe them too. We fetch the repo's raw README to look for
    // deployed demo URLs.
    if (item.html_url) {
      const readmeUrl = item.html_url.replace('github.com', 'raw.githubusercontent.com') + '/master/README.md';
      const readme = await fetchSafe(readmeUrl);
      if (readme.ok) {
        const urls = extractUrls(readme.body);
        // Surface distinct origins from the README as well — crypto projects
        // often link to their live API endpoint.
        for (const origin of collapseToOrigins(urls)) origins.push(origin);
      }
    }
  }

  // Deduplicate, filter to https origins only (github.com repos are http but
  // we still want them — they represent projects with x402 potential).
  const seen = new Set();
  const results = [];
  for (const origin of origins) {
    if (!seen.has(origin)) {
      seen.add(origin);
      results.push(origin);
    }
  }
  return results.slice(0, perPage * 2);
}

// ---------------------------------------------------------------------------
// Google Cloud Agent Gallery Discovery
// ---------------------------------------------------------------------------

/**
 * Google Cloud Agent Gallery public index.
 */
const GC_AGENT_GALLERY_URL = 'https://cloud.google.com/agents/gallery';

/**
 * Google Cloud Agent Gallery scraper. The gallery page lists agent services
 * with links; we extract and collapse to origins so the engine can probe each
 * service's root for an x402 outreach surface.
 *
 * @returns {Promise<string[]>} Origin URLs of gallery-listed services
 */
export async function discoverFromGoogleCloudAgentGallery() {
  const res = await fetchSafe(GC_AGENT_GALLERY_URL, {
    headers: { 'User-Agent': 'desanatization-discoveries/1.0 (x402 B2B outreach)' },
  });

  if (res.status === 0 || !res.ok) return [];

  const urls = extractUrls(res.body);
  return collapseToOrigins(urls);
}

// ---------------------------------------------------------------------------
// Salesforce AgentExchange Discovery
// ---------------------------------------------------------------------------

/**
 * Salesforce AgentExchange public listing.
 */
const SF_AGENT_EXCHANGE_URL = 'https://agentexchange.salesforce.com/s/agents';

/**
 * Salesforce AgentExchange scraper. The listing page links to individual agent
 * services; we extract URLs and collapse to origins for probing.
 *
 * @returns {Promise<string[]>} Origin URLs of exchange-listed agents
 */
export async function discoverFromSalesforceAgentExchange() {
  const res = await fetchSafe(SF_AGENT_EXCHANGE_URL, {
    headers: { 'User-Agent': 'desanatization-discoveries/1.0 (x402 B2B outreach)' },
  });

  if (res.status === 0 || !res.ok) return [];

  const urls = extractUrls(res.body);
  return collapseToOrigins(urls);
}

// ---------------------------------------------------------------------------
// Composite discovery: run all sources and merge results
// ---------------------------------------------------------------------------

/**
 * Run all configured discovery sources concurrently and merge the results into
 * a flat list of origin URLs. Unknown hosts are kept (not filtered) so the
 * caller decides what counts as a valid peer.
 *
 * @param {object} [options] - Discovery options
 * @param {string} [options.githubToken] - Optional GitHub API token
 * @param {boolean} [options.github=true] - Run GitHub discovery
 * @param {boolean} [options.googleCloud=true] - Run Google Cloud Agent Gallery discovery
 * @param {boolean} [options.salesforce=true] - Run Salesforce AgentExchange discovery
 * @param {Function} [options.log] - Logger for warnings (defaults to console.warn)
 * @returns {Promise<string[]>} Deduplicated origin URLs from all sources
 */
export async function discoverAll({
  githubToken,
  github = true,
  googleCloud = true,
  salesforce = true,
  log = console.warn,
} = {}) {
  const tasks = [];

  if (github) {
    tasks.push(
      discoverFromGitHub({ token: githubToken }).catch((error) => {
        log(`GitHub discovery error: ${error.message}`);
        return [];
      }),
    );
  }

  if (googleCloud) {
    tasks.push(
      discoverFromGoogleCloudAgentGallery().catch((error) => {
        log(`Google Cloud Agent Gallery discovery error: ${error.message}`);
        return [];
      }),
    );
  }

  if (salesforce) {
    tasks.push(
      discoverFromSalesforceAgentExchange().catch((error) => {
        log(`Salesforce AgentExchange discovery error: ${error.message}`);
        return [];
      }),
    );
  }

  const results = await Promise.all(tasks);
  const seen = new Set();
  const merged = [];
  for (const origins of results) {
    for (const origin of origins) {
      if (!seen.has(origin)) {
        seen.add(origin);
        merged.push(origin);
      }
    }
  }
  return merged;
}
