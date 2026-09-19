import fs from 'node:fs/promises';
import process from 'node:process';

const pendingUrl = process.env.FORGE_PENDING_URL || 'https://yomu.yomuread.workers.dev/api/fabric/forge/pending?limit=100';
const testUrl = process.env.FORGE_TEST_URL || 'https://yomu.yomuread.workers.dev/api/fabric/forge/test';
const file = new URL('../sourcepack.json', import.meta.url);
const maxPerRun = Math.max(1, Math.min(20, Number(process.env.FORGE_MAX_PER_RUN || 10)));
const recheckExisting = Math.max(0, Math.min(25, Number(process.env.FORGE_RECHECK_EXISTING || 20)));

const normalize = (raw) => {
  const u = new URL(raw);
  u.hash = '';
  u.search = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
};

async function readCurrent() {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {
      schema: 'yomu.source-pack/1',
      id: 'yomu-source-forge',
      name: 'Yomu Source Forge',
      version: 1,
      updatedAt: new Date(0).toISOString(),
      description: 'Git mirror of website sources automatically verified by Yomu Source Fabric.',
      sources: [],
    };
  }
}

async function fetchJson(url, init = {}, timeout = 45_000) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`${url} returned non-JSON (${response.status})`); }
  if (!response.ok) throw new Error(body?.error || `${url} returned HTTP ${response.status}`);
  return body;
}

async function retest(candidate) {
  const result = await fetchJson(testUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: candidate.url }),
  });
  return {
    candidate,
    accepted: result.ready === true && result.forgeable === true && Number(result.score || 0) >= 70,
    result,
  };
}

function protectedByAccessControl(result) {
  const route = String(result?.route || '');
  const message = String(result?.message || '');
  return result?.browserRequired === true
    || result?.failureKind === 'browser-required'
    || /browser-required/i.test(route)
    || /interactive access challenge|captcha|cloudflare challenge/i.test(message);
}

const current = await readCurrent();
if (current?.schema !== 'yomu.source-pack/1' || !Array.isArray(current.sources)) {
  throw new Error('sourcepack.json is not a Yomu source pack');
}

// Existing entries are rechecked conservatively. We only auto-prune when Yomu
// positively identifies an access-control/challenge state. Generic timeouts,
// transient parser misses, and upstream outages are retained for the next run.
const pruned = [];
if (recheckExisting > 0 && current.sources.length) {
  const limit = Math.min(recheckExisting, current.sources.length);
  const start = (Math.max(0, Number(current.version || 0)) * limit) % current.sources.length;
  const indexes = Array.from({ length: limit }, (_, i) => (start + i) % current.sources.length);
  const checkedUrls = new Set(indexes.map((index) => current.sources[index]?.url).filter(Boolean));

  for (const source of current.sources.filter((row) => checkedUrls.has(row?.url))) {
    try {
      const checked = await retest({ url: source.url });
      if (protectedByAccessControl(checked.result)) {
        console.log(`PRUNE ${source.url}: protected access state (${checked.result.route || 'browser-required'})`);
        pruned.push(normalize(source.url));
      } else if (checked.accepted) {
        console.log(`KEEP ${source.url}: ${checked.result.route || 'ready'} score=${checked.result.score || 0}`);
      } else {
        console.log(`KEEP ${source.url}: transient/unclassified failure (${checked.result.route || checked.result.failureKind || 'unknown'})`);
      }
    } catch (error) {
      console.log(`KEEP ${source.url}: recheck error ${error?.message || error}`);
    }
  }
}

if (pruned.length) {
  const blocked = new Set(pruned);
  current.sources = current.sources.filter((source) => {
    try { return !blocked.has(normalize(source.url)); }
    catch { return true; }
  });
}

const pending = await fetchJson(pendingUrl, {}, 30_000);
const candidates = Array.isArray(pending?.candidates) ? pending.candidates : [];
const existing = new Set(current.sources.map((source) => {
  try { return normalize(source.url); } catch { return String(source.url || ''); }
}));
const unseen = candidates
  .filter((candidate) => candidate?.url)
  .filter((candidate) => {
    try { return !existing.has(normalize(candidate.url)); }
    catch { return false; }
  })
  .slice(0, maxPerRun);

const accepted = [];
for (const candidate of unseen) {
  try {
    const checked = await retest(candidate);
    const label = `${candidate.host || candidate.url}: ${checked.result.route || 'unknown'} score=${checked.result.score || 0}`;
    if (checked.accepted) {
      console.log(`PASS ${label}`);
      accepted.push(candidate);
    } else {
      console.log(`HOLD ${label} reason=${checked.result.forgeReason || checked.result.failureKind || 'not-forgeable'}`);
    }
  } catch (error) {
    console.log(`HOLD ${candidate.host || candidate.url}: ${error?.message || error}`);
  }
}

for (const candidate of accepted) {
  const url = normalize(candidate.url);
  if (existing.has(url)) continue;
  existing.add(url);
  current.sources.push({
    url,
    tags: [...new Set((Array.isArray(candidate.tags) ? candidate.tags : ['source-forge']).map(String))].slice(0, 16),
  });
}

if (!pruned.length && !accepted.length) {
  console.log(`Source Forge: no source-pack changes (${current.sources.length} mirrored; ${unseen.length} new candidate(s) checked).`);
  process.exit(0);
}

current.sources.sort((a, b) => String(a.url).localeCompare(String(b.url)));
current.version = Math.max(1, Number(current.version || 0) + 1);
current.updatedAt = new Date().toISOString();
current.description = 'Git mirror of website sources automatically verified by Yomu Source Fabric. New candidates are independently re-tested; sources positively classified as access-protected are removed until they become usable again.';
await fs.writeFile(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
console.log(`Source Forge: added ${accepted.length}, pruned ${pruned.length}; ${current.sources.length} total.`);
