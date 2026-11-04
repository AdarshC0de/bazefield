import 'dotenv/config';
import express from 'express';

const BASE = (process.env.BAZEFIELD_BASE_URL || 'https://truboard.bazefield.com/Bazefield.Services/api').replace(/\/$/, '');
const KEY = process.env.BAZEFIELD_API_KEY;
if (!KEY) { console.error('Missing BAZEFIELD_API_KEY in .env'); process.exit(1); }

const app = express();
app.use(express.static('public'));

async function bz(path, params = {}) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Bazefield ${r.status} on ${path}: ${t.slice(0, 300)}`);
  try { return JSON.parse(t); } catch { throw new Error(`Non-JSON reply from ${path}: ${t.slice(0, 200)}`); }
}

// ---------- tolerant helpers (response shapes are not documented in the guide) ----------
const lc = s => String(s).toLowerCase();
const pick = (o, keys) => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) {
    const f = Object.keys(o).find(x => lc(x) === lc(k));
    if (f !== undefined && o[f] != null) return o[f];
  }
};
function findArray(n, test) {
  if (Array.isArray(n)) {
    if (n.length && test(n[0])) return n;
    for (const i of n) { const r = findArray(i, test); if (r) return r; }
  } else if (n && typeof n === 'object') {
    for (const v of Object.values(n)) { const r = findArray(v, test); if (r) return r; }
  }
  return null;
}
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
function flatAttrs(o) {
  const a = { ...o };
  const at = pick(o, ['Attributes', 'Properties']);
  if (Array.isArray(at)) at.forEach(x => { const k = pick(x, ['Key', 'Name']); if (k != null) a[k] = pick(x, ['Value']); });
  else if (isObj(at)) Object.assign(a, at);
  return a;
}

// ---------- plants ----------
let plantCache = { at: 0, plants: null, raw: null };
async function getPlants() {
  if (plantCache.plants && Date.now() - plantCache.at < 10 * 60e3) return plantCache;
  const raw = await bz('/objects/structure', { type: 102 });
  const arr = findArray(raw, o => isObj(o) && pick(o, ['ObjectId', 'Id']) != null) || [];
  const plants = arr.map(o => {
    const a = flatAttrs(o);
    return {
      id: String(pick(o, ['ObjectId', 'Id'])),
      name: pick(a, ['Title', 'Name', 'ShortName', 'DisplayName', 'SiteName']) || String(pick(o, ['ObjectId', 'Id'])),
      category: Number(pick(a, ['Category', 'CategoryId', 'ObjectCategory'])) || null,
      attrs: a
    };
  });
  plantCache = { at: Date.now(), plants, raw: plants.length ? null : raw };
  return plantCache;
}
app.get('/api/plants', async (_q, res) => {
  try {
    const { plants, raw } = await getPlants();
    res.json({ plants: plants.map(({ attrs, ...p }) => p), raw });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- points (schemas) ----------
const pointCache = new Map();
async function getPoints(id) {
  if (pointCache.has(id)) return pointCache.get(id);
  const raw = await bz('/objects/getschemas', { objectIds: id });
  let list = findArray(raw, o => isObj(o) && pick(o, ['Schema']) != null);
  let pts = list ? list.map(o => ({ schema: String(pick(o, ['Schema'])), desc: pick(o, ['Description', 'Title', 'Name']) || '', unit: pick(o, ['Unit', 'Units']) || '' })) : [];
  if (!pts.length) {
    const strs = findArray(raw, x => typeof x === 'string');
    if (strs) pts = strs.map(s => ({ schema: s, desc: '', unit: '' }));
  }
  pointCache.set(id, pts);
  return pts;
}

// ranked list of candidate point names, best first
function rankPoints(pts, kind = 'actual') {
  const score = p => {
    const s = lc(p.schema + ' ' + p.desc);
    if (kind === 'schedule') {
      if (!/sched|forecast|day.?ahead|dsm|declared|commit|plan/.test(s)) return -1;
      let n = 5;
      if (/power|mw|kw|gen|inj/.test(s)) n += 5;
      if (/active/.test(s)) n += 3;
      if (/reactive|energy|price|curtail/.test(s)) n -= 8;
      return n;
    }
    let n = 0;
    if (/active.?power/.test(s)) n += 10; else return -1;
    if (/meter|mtr/.test(s)) n += 3;
    if (/set.?point|ref|limit|reactive|forecast|avail|potential|curtail|capacity|sched|\bsp\b/.test(s)) n -= 8;
    return n;
  };
  return pts.map(p => [score(p), p.schema]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]).map(x => x[1]);
}
app.get('/api/points', async (req, res) => {
  try { res.json({ points: await getPoints(String(req.query.objectId)) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/related', async (req, res) => {
  try { res.json(await bz('/objects/related', { objectIds: req.query.objectId })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- data ----------
const TS = ['Time', 'Timestamp', 'DateTime', 'UtcTime', 'Date', 't', 'x'];
const VAL = ['Value', 'Val', 'v', 'y', 'Avg', 'Average'];
const SKIP = /qual|status|flag|state|count|^id$/i;   // never treat these as the measured value
const KW = { w: 0.001, kw: 1, mw: 1000, gw: 1e6 };
const kwFactor = u => KW[lc(u || '').replace(/\s/g, '')] ?? null;

const toMs = t => {
  if (typeof t === 'number') return t < 1e11 ? t * 1000 : t;
  if (typeof t === 'string') return /^\d+$/.test(t) ? toMs(+t) : Date.parse(t);
  return NaN;
};
const toNum = v => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(+v)) return +v;
  if (isObj(v)) return toNum(pick(v, ['Value', 'Avg', 'Average']) ?? Object.values(v).find(x => typeof x === 'number'));
  return null;
};
function firstNumeric(o) {
  for (const [k, v] of Object.entries(o))
    if (!TS.some(t => lc(t) === lc(k)) && !SKIP.test(k) && typeof v === 'number') return v;
  for (const [k, v] of Object.entries(o))
    if (isObj(v) && !SKIP.test(k)) { const n = firstNumeric(v); if (n != null) return n; }
  return null;
}
// If a value key exists but is null -> null. Never fall back to another field.
function rowVal(o, agg) {
  const keys = [agg, ...VAL].map(lc);
  const k = Object.keys(o).find(x => keys.includes(lc(x)));
  return k !== undefined ? toNum(o[k]) : firstNumeric(o);
}
function parseRows(raw, agg) {
  let arr = findArray(raw, o => isObj(o) && pick(o, TS) !== undefined);
  if (arr) return arr.map(o => ({ ts: toMs(pick(o, TS)), value: rowVal(o, agg) })).filter(r => !isNaN(r.ts));
  arr = findArray(raw, a => Array.isArray(a) && a.length >= 2 && !isNaN(toMs(a[0])) && typeof a[0] !== 'object');
  if (arr) return arr.map(a => ({ ts: toMs(a[0]), value: toNum(a[1]) })).filter(r => !isNaN(r.ts));
  return [];
}

app.get('/api/data', async (req, res) => {
  const { from, to, interval = '900', aggregate = 'TIMEAVERAGE', point = '', kind = 'actual' } = req.query;
  const ids = String(req.query.sites || '').split(',').filter(Boolean);
  const step = Number(interval) * 1000, IST = 19800e3;
  const snap = ts => Math.round((ts + IST) / step) * step - IST;   // align all plants to the same grid
  const toEff = kind === 'actual' ? Math.min(Number(to), Date.now()) : Number(to); // actuals can't be in the future; schedules can
  const out = {};
  await Promise.all(ids.map(async id => {
    try {
      const pts = await getPoints(id);
      let pt = String(point).trim(), cands = [];
      if (!pt) {
        cands = rankPoints(pts, kind);
        pt = cands[0];
        if (!pt) { out[id] = { rows: [], error: `No ${kind} point found in this plant's schemas. Type a point name.`, candidates: pts.map(p => p.schema) }; return; }
      }
      const unit = pts.find(p => p.schema === pt)?.unit || '';
      const f = kwFactor(unit);
      const raw = await bz('/objects/timeseries/aggregated', { objectIds: id, points: pt, aggregates: aggregate, from, to: toEff, interval });
      const rows = parseRows(raw, aggregate).map(r => ({ ts: snap(r.ts), value: r.value == null ? null : (f ? r.value * f : r.value) }));
      const meta = { point: pt, unit: f ? 'kW' : (unit || '?'), candidates: cands.slice(0, 8) };
      if (!rows.length || rows.every(r => r.value == null)) {
        const snippet = JSON.stringify(raw, null, 1).slice(0, 3000);
        console.log(`[no values] ${id} point=${pt}\n${snippet}\n`);
        out[id] = { ...meta, rows: [], error: 'API returned no usable values', raw: snippet };
      } else out[id] = { ...meta, rows };
    } catch (e) { out[id] = { rows: [], error: e.message }; }
  }));
  res.json(out);
});

app.listen(process.env.PORT || 3000, () => console.log(`Portal on http://localhost:${process.env.PORT || 3000}`));