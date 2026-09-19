import fs from 'node:fs/promises';
import process from 'node:process';

const pendingUrl = process.env.FORGE_PENDING_URL || 'https://yomu.yomuread.workers.dev/api/fabric/forge/pending?limit=100';
const testUrl = process.env.FORGE_TEST_URL || 'https://yomu.yomuread.workers.dev/api/fabric/forge/test';
const file = new URL('../sourcepack.json', import.meta.url);
const maxPerRun = Math.max(1, Math.min(20, Number(process.env.FORGE_MAX_PER_RUN || 10)));

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

const current = await readCurrent();
if (current?.schema !== 'yomu.source-pack/1' || !Array.isArray(current.sources)) {
  throw new Error('sourcepack.json is not a Yomu source pack');
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

if (!unseen.length) {
  console.log(`Source Forge: no new candidates (${current.sources.length} already mirrored).`);
  process.exit(0);
}

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

if (!accepted.length) {
  console.log('Source Forge: candidates were present, but none survived the independent Git-mirror re-test.');
  process.exit(0);
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

current.sources.sort((a, b) => String(a.url).localeCompare(String(b.url)));
current.version = Math.max(1, Number(current.version || 0) + 1);
current.updatedAt = new Date().toISOString();
current.description = 'Git mirror of website sources automatically verified by Yomu Source Fabric. Every candidate is independently re-tested before this file is updated.';
await fs.writeFile(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
console.log(`Source Forge: mirrored ${accepted.length} new source(s); ${current.sources.length} total.`);
