// RV Kitchen POS — Railway server
//
// Serves the static PWA frontend (index.html, manifest, service worker,
// icons) and implements the exact same /api/* contract that the original
// Netlify function (netlify/functions/api.mjs) used, so the frontend needs
// zero changes. Data is persisted as JSON files on disk instead of Netlify
// Blobs — point DATA_DIR at a Railway volume so it survives deploys.

import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const CODE = (process.env.RV_ACCESS_CODE || '').trim();
// Where everything is saved (orders, menu, staff, customers, slideshow photos).
// On Railway, attach a Volume to the service: Railway then sets RAILWAY_VOLUME_MOUNT_PATH
// and the app saves there automatically, so nothing is lost on redeploys or restarts.
// DATA_DIR still wins if you set it yourself.
const VOLUME = (process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
const DATA_DIR = process.env.DATA_DIR || VOLUME || process.env.RV_LOCAL_DIR || path.join(__dirname, 'data');
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
// Permanent = not on Railway (your own computer/server), or saving inside the attached volume.
const PERSISTENT = !ON_RAILWAY || (!!VOLUME && path.resolve(DATA_DIR).startsWith(path.resolve(VOLUME)));

// ---------------------------------------------------------------------
// Storage: one JSON file per key, same shape the app already expects.
// ---------------------------------------------------------------------
const keyToFile = (k) => path.join(DATA_DIR, k.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');

async function read(key, fallback) {
  try {
    const raw = await fs.readFile(keyToFile(key), 'utf8');
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

async function write(key, value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(keyToFile(key), JSON.stringify(value));
}

const dayKey = (d) => {
  const x = d ? new Date(d) : new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
};

const emptyDay = () => ({ rev: 0, seq: 0, orders: [] });

// One write at a time per day file, so two orders arriving together never overwrite each other.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run.finally(() => { if (locks.get(key) === run) locks.delete(key); }));
  return run;
}

// ---------------------------------------------------------------------
// Online ordering (public customer app at /pedir)
// ---------------------------------------------------------------------
// The restaurant's own calendar day (Railway servers run on UTC, the restaurant does not).
const SHOP_TZ = process.env.RV_TIMEZONE || 'America/Santo_Domingo';
const shopDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const DEFAULT_MENU = JSON.parse(await fs.readFile(path.join(__dirname, 'menu-default.json'), 'utf8'));
const DEF_SETTINGS = { name: 'RV Kitchen Fast Food', phone: '', addr: '', tax: 18, taxIncluded: false, delivery: 150 };
const ONLINE_OPEN = (process.env.RV_ONLINE_ORDERS || 'on').toLowerCase() !== 'off';

async function liveMenu() {
  const config = await read('config', null);
  const settings = Object.assign({}, DEF_SETTINGS, (config && config.settings) || {});
  const items = (config && Array.isArray(config.menu) && config.menu.length) ? config.menu : DEFAULT_MENU.items;
  return { settings, items };
}

// Simple per-connection limit: at most 8 order attempts every 15 minutes.
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (list.length >= 8) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  return false;
}
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------
// Specialties slideshow (top of /pedir). Edited from the admin panel (/admin).
// Until the owner saves a change, these three starter slides are shown.
// Uploaded photos live in DATA_DIR/slides (on the Railway volume).
// ---------------------------------------------------------------------
const SLIDE_DIR = path.join(DATA_DIR, 'slides');
const DEFAULT_SLIDES = {
  seconds: 4,
  slides: [
    { id: 'sl1', title: 'Combos para compartir', sub: 'Hamburguesas, papas y pollo crujiente para toda la mesa', itemId: 'cf', active: true, src: '/photos/sl-1.jpg' },
    { id: 'sl2', title: 'Bebida especial de la casa', sub: 'Bien fría, con limón y un toque picante', itemId: '', active: true, src: '/photos/sl-2.jpg' },
    { id: 'sl3', title: 'Hamburguesas jugosas', sub: 'Dobles, con queso y recién hechas', itemId: 'b3', active: true, src: '/photos/sl-3.jpg' },
  ],
};
const clampSeconds = (v) => Math.min(30, Math.max(2, Math.round(Number(v)) || 4));
async function readSlides() {
  const cfg = await read('slides', null);
  if (!cfg || !Array.isArray(cfg.slides)) return DEFAULT_SLIDES;
  return { seconds: clampSeconds(cfg.seconds), slides: cfg.slides };
}
const slideImg = (x) => x.file ? '/api/public/slide/' + encodeURIComponent(x.id) + '?v=' + (x.v || 0) : (x.src || '');

// ---------------------------------------------------------------------
// Customer accounts for the ordering app. Customers sign up with name,
// phone (WhatsApp) and a password; passwords are stored only as scrypt hashes.
// A sign-in gives the phone a random session token (header x-rv-customer).
// ---------------------------------------------------------------------
const SESSION_DAYS = 180;
const normPhone = (v) => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d.startsWith('1')) d = d.slice(1); return d; };
const scrypt = (pw, salt) => new Promise((ok, bad) => crypto.scrypt(String(pw), salt, 32, (e, k) => (e ? bad(e) : ok(k))));
async function hashPass(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: (await scrypt(pw, salt)).toString('hex') }; }
async function checkPass(pw, c) {
  if (!c || !c.salt || !c.hash) return false;
  const k = await scrypt(pw, c.salt), h = Buffer.from(c.hash, 'hex');
  return h.length === k.length && crypto.timingSafeEqual(h, k);
}
const readCustomers = () => read('customers', []);
const readSessions = () => read('csessions', {});
const publicCustomer = (c) => ({ id: c.id, name: c.name, phone: c.phone, addr: c.addr || { sector: '', street: '', ref: '', maps: '' }, createdAt: c.createdAt });
async function newSession(cid) {
  const token = crypto.randomBytes(24).toString('hex');
  await withLock('csessions', async () => {
    const all = await readSessions(), now = Date.now();
    for (const t of Object.keys(all)) if (now - all[t].at > SESSION_DAYS * 864e5) delete all[t];
    all[token] = { cid, at: now };
    await write('csessions', all);
  });
  return token;
}
async function customerFromReq(req) {
  const token = String(req.headers['x-rv-customer'] || '');
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const sess = (await readSessions())[token];
  if (!sess || Date.now() - sess.at > SESSION_DAYS * 864e5) return null;
  const c = (await readCustomers()).find((x) => x.id === sess.cid);
  return c ? { c, token } : null;
}
// ---------------------------------------------------------------------
// Inventory: ingredients with stock, recipes for menu items and options.
// Every sale (register or online app) subtracts its ingredients automatically;
// cancelling an order puts them back. An ingredient with no count yet ("stock": null)
// is not tracked, so it never marks anything as sold out.
// ---------------------------------------------------------------------
const r3 = (n) => Math.round(n * 1000) / 1000;
async function readInv() {
  const v = await read('inventory', null);
  return Object.assign({ items: [], recipes: {}, optRecipes: {}, log: [] }, v || {});
}
const tracked = (g) => g && g.stock !== null && g.stock !== undefined && g.stock !== '' && Number.isFinite(Number(g.stock));
function ingState(g) {
  if (!tracked(g)) return 'ok';
  const st = Number(g.stock);
  if (st <= 0) return 'out';
  if (g.low !== null && g.low !== undefined && g.low !== '' && st <= Number(g.low)) return 'low';
  return 'ok';
}
function needState(inv, lines) {
  let state = 'ok';
  for (const l of lines || []) {
    const g = inv.items.find((x) => x.id === l.inv);
    if (!tracked(g)) continue;
    if (Number(g.stock) < (Number(l.qty) || 0) || Number(g.stock) <= 0) return 'out';
    if (ingState(g) === 'low') state = 'low';
  }
  return state;
}
// { items: { menuId: 'out'|'low' }, opts: { 'group|option': 'out'|'low' } } — only the ones that are not fine
function availability(inv, menuItems) {
  const items = {}, opts = {};
  for (const m of menuItems || []) { const st = needState(inv, inv.recipes[m.id]); if (st !== 'ok') items[m.id] = st; }
  for (const k of Object.keys(inv.optRecipes || {})) { const st = needState(inv, inv.optRecipes[k]); if (st !== 'ok') opts[k] = st; }
  return { items, opts };
}
// What one order uses: { ingredientId: amount }
function usageOf(order, inv, menuItems) {
  const use = {};
  const add = (lines, times) => { for (const l of lines || []) if (l && l.inv) use[l.inv] = r3((use[l.inv] || 0) + (Number(l.qty) || 0) * times); };
  for (const line of order.items || []) {
    const q = Number(line.qty) || 0; if (!q) continue;
    add(inv.recipes[line.id], q);
    const m = (menuItems || []).find((x) => x.id === line.id);
    const groups = (m && m.mods) || [];
    for (const mod of line.mods || []) {
      const name = typeof mod === 'string' ? mod : mod && mod.n;
      const g = groups.find((gid) => DEFAULT_MENU.modgroups[gid] && DEFAULT_MENU.modgroups[gid].opts.some((o) => o.n === name));
      if (g) add(inv.optRecipes[g + '|' + name], q);
    }
  }
  return use;
}
// Apply a change to stock. sign = +1 subtracts (a sale), -1 adds back (a cancellation).
async function invApply(use, sign, type, note) {
  const ids = Object.keys(use || {}).filter((k) => use[k]);
  if (!ids.length) return;
  await withLock('inventory', async () => {
    const inv = await readInv();
    const ch = [];
    for (const id of ids) {
      const g = inv.items.find((x) => x.id === id);
      if (!g) continue;
      const d = r3(-sign * use[id]);
      if (tracked(g)) g.stock = r3(Number(g.stock) + d);
      ch.push([id, d]);
    }
    if (!ch.length) return;
    inv.log = [{ at: new Date().toISOString(), type, note, ch }, ...(inv.log || [])].slice(0, 1500);
    await write('inventory', inv);
  });
}
const diffUse = (a, b) => { const out = {}; for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) { const d = r3((b[k] || 0) - (a[k] || 0)); if (d) out[k] = d; } return out; };

// Sign-in attempts: at most 10 every 15 minutes per connection.
const authHits = new Map();
function tooManyAuth(ip) {
  const now = Date.now(), list = (authHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (list.length >= 10) { authHits.set(ip, list); return true; }
  list.push(now); authHits.set(ip, list); return false;
}

// ---------------------------------------------------------------------
// App
// ---------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '15mb' })); // menu photos are base64 in JSON bodies
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway sits behind one proxy; lets req.ip be the customer's address

function authorized(req) {
  if (!CODE) return true;
  const given = req.headers['x-rv-code'] || req.query.code || '';
  return given === CODE;
}

const api = express.Router();

api.get('/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    store: 'filesystem',
    dataDir: DATA_DIR,
    persistent: PERSISTENT,
    locked: !!CODE,
    time: new Date().toISOString(),
  });
});

// --- Public routes for the customer app. No access code; they can only read the menu,
// --- create a delivery order, and check the status of an order the customer owns.

api.get('/public/menu', async (req, res) => {
  try {
    const { settings, items } = await liveMenu();
    const av = availability(await readInv(), items);
    res.set('Cache-Control', 'no-cache');
    res.json({
      soldOutOpts: Object.keys(av.opts).filter((k) => av.opts[k] === 'out'),
      open: ONLINE_OPEN,
      name: settings.name, phone: settings.phone,
      tax: Number(settings.tax) || 0, taxIncluded: !!settings.taxIncluded, delivery: Number(settings.delivery) || 0,
      cats: DEFAULT_MENU.cats,
      modgroups: DEFAULT_MENU.modgroups,
      items: items.filter((m) => m && m.on !== false).map((m) => ({
        id: m.id, cat: m.cat, n: m.n, p: Number(m.p) || 0, e: m.e || '', d: m.d || '', tag: m.tag || '',
        mods: (m.mods || []).filter((g) => DEFAULT_MENU.modgroups[g]),
        img: (typeof m.img === 'string' && m.img.startsWith('data:image/')) ? '/api/public/img/' + encodeURIComponent(m.id) + '?v=' + m.img.length : '/api/public/img/' + encodeURIComponent(m.id),
        soldOut: av.items[m.id] === 'out',
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo cargar el menú' });
  }
});

api.get('/public/img/:id', async (req, res) => {
  try {
    const id = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
    const { items } = await liveMenu();
    const m = items.find((x) => x && x.id === id);
    const match = m && typeof m.img === 'string' && m.img.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    res.set('Cache-Control', 'public, max-age=3600');
    if (match) return res.type(match[1]).send(Buffer.from(match[2], 'base64'));
    for (const file of [path.join(__dirname, 'photos', id + '.jpg'), path.join(__dirname, 'photos-' + id + '.jpg')]) {
      try { await fs.access(file); return res.sendFile(file); } catch (e) { /* try the next place */ }
    }
    return res.status(404).end();
  } catch (e) {
    res.status(404).end();
  }
});

api.post('/public/account/register', async (req, res) => {
  try {
    if (tooManyAuth(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    const b = req.body || {};
    const name = clip(b.name, 60), phone = normPhone(b.phone), pw = String(b.password || '');
    if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre y apellido.' });
    if (phone.length !== 10) return res.status(400).json({ error: 'Escribe un teléfono de 10 dígitos, por ejemplo 809-555-1234.' });
    if (pw.length < 6 || pw.length > 100) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    const { salt, hash } = await hashPass(pw);
    const made = await withLock('customers', async () => {
      const list = await readCustomers();
      if (list.some((x) => x.phone === phone)) return null;
      const c = { id: 'c' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), name, phone, salt, hash, createdAt: new Date().toISOString(), addr: { sector: '', street: '', ref: '', maps: '' }, orders: [] };
      list.push(c); await write('customers', list);
      return c;
    });
    if (!made) return res.status(409).json({ error: 'Ya existe una cuenta con ese teléfono. Toca “Ya tengo cuenta” y entra con tu contraseña.' });
    res.json({ token: await newSession(made.id), customer: publicCustomer(made) });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo crear la cuenta. Inténtalo de nuevo.' });
  }
});

api.post('/public/account/login', async (req, res) => {
  try {
    if (tooManyAuth(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    const b = req.body || {};
    const c = (await readCustomers()).find((x) => x.phone === normPhone(b.phone));
    if (!c || !(await checkPass(String(b.password || ''), c))) return res.status(401).json({ error: 'Teléfono o contraseña incorrectos.' });
    res.json({ token: await newSession(c.id), customer: publicCustomer(c) });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo entrar. Inténtalo de nuevo.' });
  }
});

api.get('/public/account/me', async (req, res) => {
  try {
    const a = await customerFromReq(req);
    if (!a) return res.status(401).json({ error: 'Tu sesión terminó. Entra de nuevo.', needsAccount: true });
    const refs = (a.c.orders || []).slice(0, 30);
    const orders = [];
    const cache = {};
    for (const r of refs) {
      const day = cache[r.day] || (cache[r.day] = await read('day:' + r.day, null));
      const o = day && day.orders.find((x) => x.id === r.id);
      orders.push({ id: r.id, day: r.day, num: r.num, total: r.total, createdAt: r.createdAt, t: o ? o.trackToken : '', last: o ? o.status : 'cancelado' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ customer: publicCustomer(a.c), orders });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo cargar tu cuenta.' });
  }
});

api.patch('/public/account/me', async (req, res) => {
  try {
    const a = await customerFromReq(req);
    if (!a) return res.status(401).json({ error: 'Tu sesión terminó. Entra de nuevo.', needsAccount: true });
    const b = req.body || {};
    const out = await withLock('customers', async () => {
      const list = await readCustomers(), c = list.find((x) => x.id === a.c.id);
      if (!c) return null;
      if (b.name != null) { const n = clip(b.name, 60); if (n.length >= 2) c.name = n; }
      if (b.addr && typeof b.addr === 'object') {
        const maps = clip(b.addr.maps, 400);
        c.addr = { sector: clip(b.addr.sector, 60), street: clip(b.addr.street, 160), ref: clip(b.addr.ref, 240), maps: /^https?:\/\/\S+$/i.test(maps) ? maps : '' };
      }
      await write('customers', list);
      return c;
    });
    if (!out) return res.status(401).json({ error: 'Tu sesión terminó. Entra de nuevo.', needsAccount: true });
    res.json({ customer: publicCustomer(out) });
  } catch (e) {
    res.status(500).json({ error: 'No se pudieron guardar los cambios.' });
  }
});

api.post('/public/account/logout', async (req, res) => {
  try {
    const token = String(req.headers['x-rv-customer'] || '');
    await withLock('csessions', async () => { const all = await readSessions(); if (all[token]) { delete all[token]; await write('csessions', all); } });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

api.post('/public/orders', async (req, res) => {
  try {
    if (!ONLINE_OPEN) return res.status(403).json({ error: 'Los pedidos en línea están cerrados en este momento.' });
    const acct = await customerFromReq(req);
    if (!acct) return res.status(401).json({ error: 'Crea tu cuenta o entra para hacer tu pedido.', needsAccount: true });
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Has hecho varios pedidos seguidos. Espera unos minutos o llama al restaurante.' });
    const b = req.body || {};
    const c = b.customer || {};
    const cust = {
      name: clip(c.name, 60), phone: clip(c.phone, 20), sector: clip(c.sector, 60),
      street: clip(c.address, 160), ref: clip(c.ref, 240), maps: clip(c.maps, 400),
    };
    if (!/^https?:\/\/\S+$/i.test(cust.maps)) cust.maps = '';
    const phoneDigits = cust.phone.replace(/\D/g, '');
    if (!cust.name || phoneDigits.length < 10 || !cust.sector || !cust.street || cust.ref.length < 8) {
      return res.status(400).json({ error: 'Faltan datos de entrega: nombre, teléfono, sector, dirección y referencia.' });
    }
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 30) return res.status(400).json({ error: 'El carrito está vacío.' });

    // Prices always come from the menu on the server, never from the phone.
    const { settings, items } = await liveMenu();
    const inv = await readInv();
    const av = availability(inv, items);
    const MG = DEFAULT_MENU.modgroups;
    const lines = [];
    for (const l of b.lines) {
      const m = items.find((x) => x && x.id === l.id && x.on !== false);
      if (!m) return res.status(400).json({ error: 'Un producto de tu carrito ya no está disponible. Revisa tu pedido.' });
      if (av.items[m.id] === 'out') return res.status(400).json({ error: m.n + ' se agotó por hoy. Quítalo de tu pedido para continuar.' });
      const qty = Math.min(20, Math.max(1, Math.floor(Number(l.qty) || 1)));
      const sel = l.sel || {};
      const mods = [];
      for (const g of (m.mods || [])) {
        const G = MG[g]; if (!G) continue;
        const chosen = (Array.isArray(sel[g]) ? sel[g] : []).map(String);
        const opts = G.opts.filter((o) => chosen.includes(o.n));
        if (G.type === 'radio' && opts.length > 1) opts.length = 1;
        if (G.req && !opts.length) return res.status(400).json({ error: 'Falta elegir: ' + G.n + ' (' + m.n + ').' });
        const gone = opts.find((o) => av.opts[g + '|' + o.n] === 'out');
        if (gone) return res.status(400).json({ error: gone.n + ' se agotó por hoy (' + m.n + '). Elige otra opción.' });
        opts.forEach((o) => mods.push({ n: o.n, p: o.p }));
      }
      const unit = (Number(m.p) || 0) + mods.reduce((a, o) => a + o.p, 0);
      lines.push({
        uid: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        id: m.id, name: m.n, emo: m.e || '', unit, qty, mods, note: clip(l.note, 120),
      });
    }

    // Same math as the register (totals() in index.html), with the delivery charge from Ajustes.
    const itemsTotal = lines.reduce((a, l) => a + l.unit * l.qty, 0);
    const del = Number(settings.delivery) || 0;
    const gross = itemsTotal + del;
    const r = (Number(settings.tax) || 0) / 100;
    let base, tax, total;
    if (settings.taxIncluded) { total = gross; base = r ? gross / (1 + r) : gross; tax = gross - base; }
    else { base = gross; tax = gross * r; total = gross + tax; }
    total = round2(total);

    const method = b.pay === 'tarjeta' ? 'tarjeta' : 'efectivo';
    const cashFrom = method === 'efectivo' ? Math.max(0, Math.floor(Number(b.cashFrom) || 0)) : 0;
    if (cashFrom && cashFrom < total) return res.status(400).json({ error: 'El efectivo indicado es menor que el total.' });

    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const date = shopDay();
    const key = 'day:' + date;
    const order = await withLock(key, async () => {
      const day = await read(key, emptyDay());
      const o = {
        type: 'delivery',
        source: 'online',
        cust: {
          name: cust.name, phone: cust.phone,
          addr: cust.street + ', ' + cust.sector + ' · Ref: ' + cust.ref,
          sector: cust.sector, ref: cust.ref, maps: cust.maps,
        },
        items: lines,
        itemsTotal: round2(itemsTotal), delivery: del, discount: 0,
        base: round2(base), tax: round2(tax), taxRate: Number(settings.tax) || 0, total,
        pay: { method, received: cashFrom, change: cashFrom ? round2(cashFrom - total) : 0 },
        paid: false,
        user: 'Pedido en línea', userId: '', customerId: acct.c.id,
        trackToken: token,
        id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        num: day.seq + 1,
        day: date,
        status: 'pend',
        createdAt: new Date().toISOString(),
        doneAt: null,
      };
      o.invUsed = usageOf(o, inv, items);
      day.seq += 1;
      day.rev += 1;
      day.orders.unshift(o);
      await write(key, day);
      return o;
    });
    await invApply(order.invUsed, 1, 'sale', 'Pedido #' + order.num + ' (app)').catch(() => {});
    // Remember the order and the latest delivery address on the customer's account.
    await withLock('customers', async () => {
      const list = await readCustomers(), c = list.find((x) => x.id === acct.c.id);
      if (!c) return;
      c.orders = [{ id: order.id, day: order.day, num: order.num, total: order.total, createdAt: order.createdAt }, ...(c.orders || [])].slice(0, 200);
      c.addr = { sector: cust.sector, street: cust.street, ref: cust.ref, maps: cust.maps };
      await write('customers', list);
    }).catch(() => {});
    res.json({ id: order.id, num: order.num, day: order.day, token, total: order.total, createdAt: order.createdAt });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo registrar el pedido. Inténtalo de nuevo.' });
  }
});

api.get('/public/orders/:id', async (req, res) => {
  try {
    const date = String(req.query.day || '').replace(/[^0-9-]/g, '');
    const day = await read('day:' + date, null);
    const o = day && day.orders.find((x) => x.id === req.params.id);
    if (!o || !o.trackToken || o.trackToken !== String(req.query.t || '')) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.set('Cache-Control', 'no-store');
    res.json({
      num: o.num, status: o.status, createdAt: o.createdAt, doneAt: o.doneAt,
      total: o.total, itemsTotal: o.itemsTotal, delivery: o.delivery, tax: o.tax, taxRate: o.taxRate,
      pay: o.pay && o.pay.method, paid: !!o.paid,
      items: o.items.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, mods: (l.mods || []).map((m) => m.n), note: l.note || '' })),
      addr: o.cust && o.cust.addr,
    });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo consultar el pedido' });
  }
});

// --- Specialties slideshow: public read (the customer app shows these at the top of the menu).
api.get('/public/slides', async (req, res) => {
  try {
    const cfg = await readSlides();
    res.set('Cache-Control', 'no-cache');
    res.json({
      seconds: cfg.seconds,
      slides: cfg.slides
        .filter((x) => x.active !== false && slideImg(x))
        .map((x) => ({ id: x.id, title: x.title || '', sub: x.sub || '', itemId: x.itemId || '', img: slideImg(x) })),
    });
  } catch (e) {
    res.status(500).json({ error: 'slides' });
  }
});

api.get('/public/slide/:id', async (req, res) => {
  try {
    const cfg = await readSlides();
    const x = cfg.slides.find((y) => y.id === req.params.id);
    if (!x || !x.file || !/^[A-Za-z0-9_.-]+$/.test(x.file)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(x.file, { root: SLIDE_DIR }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch (e) {
    res.status(404).end();
  }
});

// Everything below /health requires the access code (if one is configured).
api.use((req, res, next) => {
  if (req.path.startsWith('/admin/') || req.path === '/admin') return next();   // admin panel has its own username + password
  if (!authorized(req)) return res.status(401).json({ error: 'Código de acceso inválido' });
  next();
});

// What the register shows on each product: 'out' (Agotado) or 'low' (Quedan pocos).
api.get('/inventory/status', async (req, res) => {
  try {
    const [{ items }, inv] = await Promise.all([liveMenu(), readInv()]);
    res.set('Cache-Control', 'no-store');
    res.json(availability(inv, items));
  } catch (e) {
    res.json({ items: {}, opts: {} });
  }
});

api.get('/bootstrap', async (req, res) => {
  try {
    const date = req.query.date || dayKey();
    const [config, staff, day, shifts] = await Promise.all([
      read('config', null),
      read('staff', null),
      read('day:' + date, emptyDay()),
      read('shifts', []),
    ]);
    res.json({ config, staff, orders: day.orders, rev: day.rev, shifts });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.get('/poll', async (req, res) => {
  try {
    const date = req.query.date || dayKey();
    const rev = Number(req.query.rev || 0);
    const day = await read('day:' + date, emptyDay());
    if (day.rev === rev) return res.json({ rev: day.rev });
    res.json({ rev: day.rev, orders: day.orders });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.get('/config', async (req, res) => {
  try {
    res.json(await read('config', null));
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.put('/config', async (req, res) => {
  try {
    const body = req.body || {};
    await write('config', { settings: body.settings, menu: body.menu });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.get('/staff', async (req, res) => {
  try {
    res.json(await read('staff', []));
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.put('/staff', async (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.staff)) return res.status(400).json({ error: 'lista inválida' });
    await write('staff', body.staff);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.post('/clock', async (req, res) => {
  try {
    const body = req.body || {};
    const list = await read('shifts', []);
    if (body.action === 'in') {
      const s = {
        id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        staffId: body.staffId,
        name: body.name,
        in: new Date().toISOString(),
        out: null,
      };
      list.unshift(s);
      await write('shifts', list.slice(0, 3000));
      return res.json(s);
    }
    const s = list.find((x) => x.id === body.shiftId);
    if (s && !s.out) s.out = new Date().toISOString();
    await write('shifts', list);
    res.json(s || { ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.get('/shifts', async (req, res) => {
  try {
    res.json(await read('shifts', []));
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.post('/orders', async (req, res) => {
  try {
    const body = req.body || {};
    const date = body.date || dayKey();
    const key = 'day:' + date;
    if (!body.order || !Array.isArray(body.order.items) || !body.order.items.length) {
      return res.status(400).json({ error: 'Orden vacía' });
    }
    const [{ items: menuItems }, inv] = await Promise.all([liveMenu(), readInv()]);
    const order = await withLock(key, async () => {
    const day = await read(key, emptyDay());
    const order = Object.assign({ paid: true }, body.order, {
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      num: day.seq + 1,
      day: date,
      status: 'pend',
      createdAt: new Date().toISOString(),
      doneAt: null,
    });
    order.invUsed = order.status === 'cancelado' ? {} : usageOf(order, inv, menuItems);
    delete order.invBack;
    day.seq += 1;
    day.rev += 1;
    day.orders.unshift(order);
    await write(key, day);
    return order;
    });
    await invApply(order.invUsed, 1, 'sale', 'Orden #' + order.num + ' (caja)').catch(() => {});
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.patch('/orders', async (req, res) => {
  try {
    const body = req.body || {};
    const date = body.date || dayKey();
    const key = 'day:' + date;
    const [{ items: menuItems }, inv] = await Promise.all([liveMenu(), readInv()]);
    let invChange = null, invNote = '';
    const o = await withLock(key, async () => {
    const day = await read(key, emptyDay());
    const o = day.orders.find((x) => x.id === body.id);
    if (!o) return null;
    const wasCancelled = o.status === 'cancelado';
    const oldUse = o.invUsed || null;
    const valid = ['pend', 'prep', 'listo', 'entregado', 'cancelado'];
    if (body.status && valid.includes(body.status)) {
      o.status = body.status;
      if (['entregado', 'cancelado'].includes(o.status)) o.doneAt = new Date().toISOString();
    }
    if (body.patch && typeof body.patch === 'object') {
      const allowed = [
        'type', 'cust', 'items', 'itemsTotal', 'delivery', 'discount', 'base',
        'tax', 'total', 'pay', 'paid', 'paidAt', 'paidBy', 'editedAt', 'editedBy',
      ];
      for (const k of allowed) if (k in body.patch) o[k] = body.patch[k];
    }
    // keep the inventory in step with the order
    if (oldUse) {
      const nowCancelled = o.status === 'cancelado';
      if (!wasCancelled && nowCancelled) { invChange = { use: oldUse, sign: -1 }; invNote = 'Orden #' + o.num + ' cancelada'; }
      else if (wasCancelled && !nowCancelled) { invChange = { use: oldUse, sign: 1 }; invNote = 'Orden #' + o.num + ' reactivada'; }
      if (!nowCancelled && body.patch && Array.isArray(body.patch.items)) {
        const newUse = usageOf(o, inv, menuItems);
        const base = invChange && invChange.sign === 1 ? {} : oldUse;   // reactivated orders charge the new items in full
        const d = diffUse(base, newUse);
        invChange = { use: d, sign: 1 }; invNote = 'Orden #' + o.num + ' editada';
        o.invUsed = newUse;
      }
    }
    day.rev += 1;
    await write(key, day);
    return o;
    });
    if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
    if (invChange) await invApply(invChange.use, invChange.sign, invChange.sign < 0 ? 'return' : 'sale', invNote).catch(() => {});
    res.json(o);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.delete('/orders', async (req, res) => {
  try {
    const date = req.query.date || dayKey();
    const id = req.query.id;
    const key = 'day:' + date;
    const result = await withLock(key, async () => {
    const day = await read(key, emptyDay());
    if (id) {
      const before = day.orders.length;
      day.orders = day.orders.filter((x) => x.id !== id);
      day.rev += 1;
      await write(key, day);
      return { ok: true, deleted: before - day.orders.length };
    }
    await write(key, { rev: day.rev + 1, seq: day.seq, orders: [] });
    return { ok: true };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

api.get('/orders', async (req, res) => {
  try {
    const from = req.query.from || dayKey();
    const to = req.query.to || from;
    const out = [];
    const cursor = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    let guard = 0;
    while (cursor <= end && guard++ < 120) {
      const day = await read('day:' + dayKey(cursor), null);
      if (day && day.orders) out.push(...day.orders);
      cursor.setDate(cursor.getDate() + 1);
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------------
// Admin panel API (/admin): sales numbers + slideshow editor.
// Sign in with a username and password. The first time the server starts it creates
//   username: ADMIN   password: Admin01
// (or RV_ADMIN_USER / RV_ADMIN_PASSWORD if you set those in Railway).
// Change the password from the admin panel → Settings. Only a scrypt hash is stored.
// Sign-ins last 30 days and are saved to disk, so restarts and redeploys don't sign you out.
// ---------------------------------------------------------------------
const ADMIN_DAYS = 30;
async function adminCreds() {
  let a = await read('admin', null);
  if (!a || !a.user || !a.hash) {
    const { salt, hash } = await hashPass(process.env.RV_ADMIN_PASSWORD || 'Admin01');
    a = { user: (process.env.RV_ADMIN_USER || 'ADMIN').trim(), salt, hash, changedAt: null };
    await write('admin', a);
  }
  return a;
}
const readAdminSessions = () => read('asessions', {});
// Forgot the admin password? Set RV_ADMIN_PASSWORD in Railway: on the next start it replaces the
// saved one (and signs everyone out). Remove the variable afterwards so the panel can change it again.
(async () => {
  const want = process.env.RV_ADMIN_PASSWORD;
  if (!want) return;
  const a = await adminCreds();
  if (await checkPass(want, a)) return;
  const { salt, hash } = await hashPass(want);
  await write('admin', { user: (process.env.RV_ADMIN_USER || a.user).trim(), salt, hash, changedAt: new Date().toISOString() });
  await write('asessions', {});
  console.log('Admin password was reset from RV_ADMIN_PASSWORD.');
})().catch(() => {});
const admin = express.Router();

admin.post('/login', async (req, res) => {
  try {
    if (tooManyAuth(req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    const b = req.body || {};
    const a = await adminCreds();
    const okUser = String(b.user || '').trim().toLowerCase() === a.user.toLowerCase();
    const okPass = await checkPass(String(b.password || ''), a);
    if (!okUser || !okPass) return res.status(401).json({ error: 'Wrong username or password.' });
    const token = crypto.randomBytes(24).toString('hex');
    await withLock('asessions', async () => {
      const all = await readAdminSessions(), now = Date.now();
      for (const t of Object.keys(all)) if (now - all[t].at > ADMIN_DAYS * 864e5) delete all[t];
      all[token] = { at: now };
      await write('asessions', all);
    });
    res.json({ token, user: a.user, defaultPassword: !a.changedAt });
  } catch (e) {
    res.status(500).json({ error: 'Could not sign in. Try again.' });
  }
});

// Everything else in the admin panel needs a valid sign-in.
admin.use(async (req, res, next) => {
  try {
    const token = String(req.headers['x-rv-admin'] || '');
    const s = /^[a-f0-9]{48}$/.test(token) && (await readAdminSessions())[token];
    if (!s || Date.now() - s.at > ADMIN_DAYS * 864e5) return res.status(401).json({ error: 'Please sign in again.' });
    req.adminToken = token;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Please sign in again.' });
  }
});

admin.get('/ping', async (req, res) => {
  const a = await adminCreds();
  res.json({ ok: true, tz: SHOP_TZ, today: shopDay(), user: a.user, defaultPassword: !a.changedAt, persistent: PERSISTENT, onRailway: ON_RAILWAY,
    shopUrl: SHOP_DOMAINS[0] ? 'https://' + SHOP_DOMAINS[0] : '', adminDomain: ADMIN_DOMAINS.includes(hostOf(req)) });
});

admin.post('/logout', async (req, res) => {
  await withLock('asessions', async () => { const all = await readAdminSessions(); delete all[req.adminToken]; await write('asessions', all); }).catch(() => {});
  res.json({ ok: true });
});

admin.post('/password', async (req, res) => {
  try {
    const b = req.body || {};
    const a = await adminCreds();
    if (!(await checkPass(String(b.current || ''), a))) return res.status(400).json({ error: 'The current password is not right.' });
    const next = String(b.next || '');
    if (next.length < 6) return res.status(400).json({ error: 'The new password must have at least 6 characters.' });
    const user = clip(b.user || a.user, 40) || a.user;
    const { salt, hash } = await hashPass(next);
    await write('admin', { user, salt, hash, changedAt: new Date().toISOString() });
    // sign out every other device
    await withLock('asessions', async () => { const all = await readAdminSessions(); for (const t of Object.keys(all)) if (t !== req.adminToken) delete all[t]; await write('asessions', all); });
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ error: 'Could not change the password.' });
  }
});

// Start fresh: erase test orders and/or customer accounts. Menu, employees, settings and slideshow stay.
admin.post('/erase', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.confirm !== 'ERASE') return res.status(400).json({ error: 'Type ERASE to confirm.' });
    let orders = 0, customers = 0;
    if (b.orders) {
      for (const d of await listDayKeys()) {
        await withLock('day:' + d, async () => {
          const day = await read('day:' + d, null);
          if (day && Array.isArray(day.orders)) orders += day.orders.length;
          await fs.unlink(keyToFile('day:' + d)).catch(() => {});
        });
        dayCache.delete(d);
      }
    }
    if (b.customers) {
      await withLock('customers', async () => { customers = (await readCustomers()).length; await write('customers', []); });
      await withLock('csessions', async () => { await write('csessions', {}); });
    }
    res.json({ ok: true, orders, customers });
  } catch (e) {
    res.status(500).json({ error: 'Could not erase the data.' });
  }
});

// ----- slideshow -----
admin.get('/slides', async (req, res) => {
  try {
    const cfg = await readSlides();
    const { items } = await liveMenu();
    res.set('Cache-Control', 'no-store');
    res.json({
      seconds: cfg.seconds,
      slides: cfg.slides.map((x) => ({ id: x.id, title: x.title || '', sub: x.sub || '', itemId: x.itemId || '', active: x.active !== false, img: slideImg(x) })),
      items: items.filter((m) => m && m.on !== false).map((m) => ({ id: m.id, n: m.n })),
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load the slides.' });
  }
});

admin.put('/slides', async (req, res) => {
  try {
    const b = req.body || {};
    const incoming = Array.isArray(b.slides) ? b.slides : null;
    if (!incoming || incoming.length > 12) return res.status(400).json({ error: 'You can have up to 12 slides.' });
    const result = await withLock('slides', async () => {
      const cur = await readSlides();
      const byId = new Map(cur.slides.map((x) => [x.id, x]));
      const used = new Set();
      const out = [];
      const keep = new Set();
      await fs.mkdir(SLIDE_DIR, { recursive: true });
      for (const x of incoming) {
        const prev = byId.get(String(x.id || ''));
        const reuse = prev && !used.has(prev.id);
        const slide = {
          id: reuse ? prev.id : 'sl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          title: clip(x.title, 60), sub: clip(x.sub, 120), itemId: clip(x.itemId, 24), active: x.active !== false,
          src: reuse ? (prev.src || '') : '', file: reuse ? (prev.file || '') : '', v: reuse ? (prev.v || 0) : 0,
        };
        used.add(slide.id);
        if (typeof x.imgData === 'string' && x.imgData) {
          const m = x.imgData.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
          if (!m) return { error: 'That photo format is not supported. Use JPG, PNG or WebP.' };
          const buf = Buffer.from(m[2], 'base64');
          if (buf.length > 2 * 1024 * 1024) return { error: 'That photo is too large (max 2 MB).' };
          const file = slide.id + '-' + Date.now().toString(36) + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
          await fs.writeFile(path.join(SLIDE_DIR, file), buf);
          slide.file = file; slide.src = ''; slide.v = Date.now();
        }
        if (!slide.file && !slide.src) return { error: 'Every slide needs a photo.' };
        if (slide.file) keep.add(slide.file);
        out.push(slide);
      }
      await write('slides', { seconds: clampSeconds(b.seconds), slides: out });
      for (const f of await fs.readdir(SLIDE_DIR).catch(() => [])) if (!keep.has(f)) await fs.unlink(path.join(SLIDE_DIR, f)).catch(() => {});
      return { ok: true };
    });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Could not save the slides.' });
  }
});

admin.delete('/slides', async (req, res) => {
  try {
    await withLock('slides', async () => {
      await fs.unlink(keyToFile('slides')).catch(() => {});
      for (const f of await fs.readdir(SLIDE_DIR).catch(() => [])) await fs.unlink(path.join(SLIDE_DIR, f)).catch(() => {});
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not restore the starter slides.' });
  }
});

// ----- sales numbers -----
// One small summary per day (kept in memory for past days), split by channel:
// "online" = orders from the customer app, "pos" = orders rung up at the register.
const HOUR_FMT = new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TZ, hour: 'numeric', hourCycle: 'h23' });
const hourOf = (iso) => { const h = parseInt(HOUR_FMT.format(new Date(iso)), 10); return Number.isFinite(h) ? h % 24 : 0; };
const bump = (map, k, n, r) => { const e = map[k] || (map[k] = [0, 0]); e[0] += n; e[1] = round2(e[1] + r); };

function summarizeDay(d, orders) {
  const ch = {};
  for (const o of orders) {
    const c = o.source === 'online' ? 'online' : 'pos';
    const b = ch[c] || (ch[c] = { n: 0, rev: 0, paid: 0, canc: 0, cancRev: 0, items: {}, pay: {}, type: {}, hn: Array(24).fill(0), hr: Array(24).fill(0) });
    const total = Number(o.total) || 0;
    if (o.status === 'cancelado') { b.canc += 1; b.cancRev = round2(b.cancRev + total); continue; }
    b.n += 1; b.rev = round2(b.rev + total);
    if (o.paid !== false) b.paid = round2(b.paid + total);
    const h = hourOf(o.createdAt || Date.now());
    b.hn[h] += 1; b.hr[h] = round2(b.hr[h] + total);
    bump(b.pay, (o.pay && o.pay.method) || 'otro', 1, total);
    bump(b.type, o.type || 'aqui', 1, total);
    for (const l of (o.items || [])) bump(b.items, String(l.name || '?').slice(0, 60), Number(l.qty) || 0, (Number(l.unit) || 0) * (Number(l.qty) || 0));
  }
  return { d, ch };
}

const dayCache = new Map();
async function listDayKeys() {
  const files = await fs.readdir(DATA_DIR).catch(() => []);
  return files.map((f) => /^day_(\d{4}-\d{2}-\d{2})\.json$/.exec(f)).filter(Boolean).map((m) => m[1]).sort();
}

admin.get('/days', async (req, res) => {
  try {
    const keys = await listDayKeys();
    const days = [];
    for (const d of keys) {
      const st = await fs.stat(keyToFile('day:' + d)).catch(() => null);
      if (!st) continue;
      const hit = dayCache.get(d);
      let sum;
      if (hit && hit.m === st.mtimeMs) sum = hit.sum;
      else {
        const day = await read('day:' + d, null);
        sum = day && Array.isArray(day.orders) && day.orders.length ? summarizeDay(d, day.orders) : null;
        dayCache.set(d, { m: st.mtimeMs, sum });
      }
      if (sum) days.push(sum);
    }
    res.set('Cache-Control', 'no-store');
    res.json({ tz: SHOP_TZ, today: shopDay(), days });
  } catch (e) {
    res.status(500).json({ error: 'Could not load the sales numbers.' });
  }
});

// Latest orders in a date range (newest first), slim version for the admin table.
admin.get('/orders', async (req, res) => {
  try {
    const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const from = ok(req.query.from) ? req.query.from : '0000-00-00';
    const to = ok(req.query.to) ? req.query.to : '9999-99-99';
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
    const keys = (await listDayKeys()).filter((d) => d >= from && d <= to).reverse();
    const out = [];
    for (const d of keys) {
      const day = await read('day:' + d, null);
      if (!day || !Array.isArray(day.orders)) continue;
      const list = day.orders.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      for (const o of list) {
        out.push({
          id: o.id, num: o.num, day: d, createdAt: o.createdAt, status: o.status, type: o.type || 'aqui',
          source: o.source === 'online' ? 'online' : 'pos', total: Number(o.total) || 0, paid: o.paid !== false,
          pay: (o.pay && o.pay.method) || '', name: (o.cust && o.cust.name) || '',
          items: (o.items || []).map((l) => (Number(l.qty) || 1) + '× ' + l.name).join(', ').slice(0, 160),
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ orders: out, limited: out.length >= limit });
  } catch (e) {
    res.status(500).json({ error: 'Could not load the orders.' });
  }
});

// ----- inventory -----
const UNITS = ['unid', 'lb', 'oz', 'kg', 'g', 'lt', 'galón', 'botella', 'lata', 'paquete', 'caja', 'bolsa'];
async function invPayload() {
  const [{ items }, inv] = await Promise.all([liveMenu(), readInv()]);
  const av = availability(inv, items);
  return {
    items: inv.items.map((g) => Object.assign({}, g, { state: ingState(g) })),
    recipes: inv.recipes, optRecipes: inv.optRecipes, log: (inv.log || []).slice(0, 150),
    menu: items.filter((m) => m && m.on !== false).map((m) => ({ id: m.id, n: m.n, cat: m.cat, mods: (m.mods || []).filter((g) => DEFAULT_MENU.modgroups[g]) })),
    cats: DEFAULT_MENU.cats, modgroups: DEFAULT_MENU.modgroups, units: UNITS, availability: av,
  };
}
admin.get('/inventory', async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await invPayload()); }
  catch (e) { res.status(500).json({ error: 'Could not load the inventory.' }); }
});
const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : r3(Number(v)));
admin.put('/inventory/item', async (req, res) => {
  try {
    const b = req.body || {};
    const name = clip(b.name, 60);
    if (!name) return res.status(400).json({ error: 'Write a name for the ingredient.' });
    await withLock('inventory', async () => {
      const inv = await readInv();
      let g = inv.items.find((x) => x.id === b.id);
      if (!g) { g = { id: 'i' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), stock: num(b.stock) }; inv.items.push(g); }
      g.name = name; g.unit = clip(b.unit, 20) || 'unid'; g.low = num(b.low); g.cost = num(b.cost);
      await write('inventory', inv);
    });
    res.json(await invPayload());
  } catch (e) { res.status(500).json({ error: 'Could not save the ingredient.' }); }
});
admin.delete('/inventory/item/:id', async (req, res) => {
  try {
    await withLock('inventory', async () => {
      const inv = await readInv();
      inv.items = inv.items.filter((x) => x.id !== req.params.id);
      for (const book of [inv.recipes, inv.optRecipes]) for (const k of Object.keys(book)) { book[k] = book[k].filter((l) => l.inv !== req.params.id); if (!book[k].length) delete book[k]; }
      await write('inventory', inv);
    });
    res.json(await invPayload());
  } catch (e) { res.status(500).json({ error: 'Could not delete the ingredient.' }); }
});
// restock = add, count = set the real amount, waste = remove (spoiled, dropped…)
admin.post('/inventory/move', async (req, res) => {
  try {
    const b = req.body || {};
    const qty = num(b.qty);
    if (qty === null || qty < 0) return res.status(400).json({ error: 'Write a number (0 or more).' });
    if (!['restock', 'count', 'waste'].includes(b.type)) return res.status(400).json({ error: 'Unknown movement.' });
    let err = '';
    await withLock('inventory', async () => {
      const inv = await readInv();
      const g = inv.items.find((x) => x.id === b.inv);
      if (!g) { err = 'Ingredient not found.'; return; }
      const before = tracked(g) ? Number(g.stock) : 0;
      const after = b.type === 'count' ? qty : b.type === 'restock' ? r3(before + qty) : r3(before - qty);
      g.stock = after;
      inv.log = [{ at: new Date().toISOString(), type: b.type, note: clip(b.note, 120), ch: [[g.id, r3(after - before)]], set: b.type === 'count' ? after : undefined }, ...(inv.log || [])].slice(0, 1500);
      await write('inventory', inv);
    });
    if (err) return res.status(404).json({ error: err });
    res.json(await invPayload());
  } catch (e) { res.status(500).json({ error: 'Could not save the movement.' }); }
});
// recipe for a menu item ({ item }) or for an option ({ opt: 'group|Option name' })
admin.put('/inventory/recipe', async (req, res) => {
  try {
    const b = req.body || {};
    const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({ inv: String(l.inv || ''), qty: num(l.qty) })).filter((l) => l.inv && l.qty > 0).slice(0, 20);
    await withLock('inventory', async () => {
      const inv = await readInv();
      const ids = new Set(inv.items.map((x) => x.id));
      const clean = lines.filter((l) => ids.has(l.inv));
      const book = b.opt ? inv.optRecipes : inv.recipes, key = clip(b.opt || b.item, 80);
      if (!key) return;
      if (clean.length) book[key] = clean; else delete book[key];
      await write('inventory', inv);
    });
    res.json(await invPayload());
  } catch (e) { res.status(500).json({ error: 'Could not save the recipe.' }); }
});
// A starting list of ingredients and recipes for the RV Kitchen menu (nothing counted yet).
admin.post('/inventory/starter', async (req, res) => {
  try {
    const { items } = await liveMenu();
    const has = new Set(items.map((m) => m.id));
    await withLock('inventory', async () => {
      const inv = await readInv();
      const ING = [
        ['pan', 'Pan de hamburguesa', 'unid', 24], ['carne', 'Carne de res (torta)', 'unid', 24], ['pechuga', 'Pechuga empanizada', 'unid', 12],
        ['queso', 'Queso americano (lonja)', 'unid', 30], ['papas', 'Papas congeladas', 'lb', 10], ['presa', 'Pollo frito (presa)', 'unid', 12],
        ['pollo', 'Pollo desmenuzado', 'lb', 3], ['salami', 'Salami', 'lb', 3], ['salchicha', 'Salchicha', 'unid', 12], ['panhd', 'Pan de hot dog', 'unid', 12],
        ['tocineta', 'Tocineta (lonja)', 'unid', 12], ['huevo', 'Huevos', 'unid', 12], ['soda', 'Soda en lata', 'unid', 24], ['agua', 'Agua en botella', 'unid', 12],
      ];
      const idOf = {};
      for (const [key, name, unit, low] of ING) {
        let g = inv.items.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!g) { g = { id: 'i' + key, name, unit, stock: null, low, cost: null }; if (inv.items.some((x) => x.id === g.id)) g.id += Date.now().toString(36); inv.items.push(g); }
        idOf[key] = g.id;
      }
      const R = (pairs) => pairs.map(([k, q]) => ({ inv: idOf[k], qty: q }));
      const RECIPES = {
        c1: [['pan', 1], ['carne', 1], ['papas', 0.33]], c2: [['pan', 1], ['carne', 1], ['queso', 1], ['papas', 0.33]],
        c3: [['pan', 1], ['pechuga', 1], ['papas', 0.33]], c4: [['pan', 1], ['carne', 2], ['queso', 2], ['papas', 0.33]],
        cy: [['papas', 0.5], ['queso', 1]], cf: [['pan', 3], ['carne', 3], ['papas', 1], ['soda', 2]],
        b1: [['pan', 1], ['carne', 1]], b2: [['pan', 1], ['carne', 1], ['queso', 1]], b3: [['pan', 1], ['carne', 2], ['queso', 2]], b4: [['pan', 1], ['pechuga', 1]],
        s1: [['papas', 0.4]], s2: [['papas', 0.4], ['salami', 0.2], ['queso', 1]], s3: [['papas', 0.4], ['pollo', 0.2], ['queso', 1]], s4: [['papas', 0.4], ['salami', 0.1], ['pollo', 0.1], ['queso', 1]],
        y1: [['papas', 0.4], ['queso', 1]], y2: [['papas', 0.6], ['queso', 2]], p1: [['presa', 2], ['papas', 0.33]], p2: [['pan', 1], ['pollo', 0.25]],
        a1: [['salchicha', 1], ['panhd', 1]], d1: [['soda', 1]], d3: [['agua', 1]],
      };
      for (const [id, pairs] of Object.entries(RECIPES)) if (has.has(id) && !inv.recipes[id]) inv.recipes[id] = R(pairs);
      const OPT = {
        'drink|Coca-Cola': [['soda', 1]], 'drink|Coca-Cola Zero': [['soda', 1]], 'drink|Sprite': [['soda', 1]], 'drink|Fanta': [['soda', 1]], 'drink|Country Club': [['soda', 1]], 'drink|Agua': [['agua', 1]],
        'extras|Queso extra': [['queso', 1]], 'extras|Salami': [['salami', 0.1]], 'extras|Pollo': [['pollo', 0.1]], 'extras|Tocineta': [['tocineta', 1]], 'extras|Huevo': [['huevo', 1]],
        'yaroa|Pollo': [['pollo', 0.25]], 'yaroa|Salami': [['salami', 0.25]], 'yaroa|Mixta': [['pollo', 0.15], ['salami', 0.15]],
      };
      for (const [k, pairs] of Object.entries(OPT)) if (!inv.optRecipes[k]) inv.optRecipes[k] = R(pairs);
      await write('inventory', inv);
    });
    res.json(await invPayload());
  } catch (e) { res.status(500).json({ error: 'Could not load the starter list.' }); }
});

// ----- customers -----
admin.get('/customers', async (req, res) => {
  try {
    const list = await readCustomers();
    res.set('Cache-Control', 'no-store');
    res.json({
      customers: list.map((c) => ({
        id: c.id, name: c.name, phone: c.phone, createdAt: c.createdAt,
        orders: (c.orders || []).length, spent: round2((c.orders || []).reduce((a, o) => a + (Number(o.total) || 0), 0)),
        last: (c.orders && c.orders[0] && c.orders[0].createdAt) || '',
        sector: (c.addr && c.addr.sector) || '',
      })).sort((a, b) => String(b.last || b.createdAt).localeCompare(String(a.last || a.createdAt))),
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load the customers.' });
  }
});

// The customer forgot the password: make a temporary 6-digit one and sign them out everywhere.
admin.post('/customers/:id/reset', async (req, res) => {
  try {
    const temp = String(crypto.randomInt(100000, 1000000));
    const { salt, hash } = await hashPass(temp);
    const ok = await withLock('customers', async () => {
      const list = await readCustomers(), c = list.find((x) => x.id === req.params.id);
      if (!c) return false;
      c.salt = salt; c.hash = hash; await write('customers', list); return true;
    });
    if (!ok) return res.status(404).json({ error: 'Customer not found.' });
    await withLock('csessions', async () => { const all = await readSessions(); for (const t of Object.keys(all)) if (all[t].cid === req.params.id) delete all[t]; await write('csessions', all); });
    res.json({ temp });
  } catch (e) {
    res.status(500).json({ error: 'Could not reset the password.' });
  }
});

api.use('/admin', admin);

api.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada: ' + req.path });
});

app.use('/api', api);

// ---------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Separate web addresses (optional). Point extra domains at this same service in Railway and set:
//   RV_SHOP_DOMAIN  = pedir.yourdomain.com   → customers see only the ordering app there
//   RV_ADMIN_DOMAIN = admin.yourdomain.com   → opens straight into the admin panel
// Both use the same data, so the admin panel always shows the app's orders and customers.
// The railway.app address keeps working for everything (register at /, /pedir, /admin).
// ---------------------------------------------------------------------
const domains = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
const SHOP_DOMAINS = domains(process.env.RV_SHOP_DOMAIN);
const ADMIN_DOMAINS = domains(process.env.RV_ADMIN_DOMAIN);
const hostOf = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();
app.use((req, res, next) => {
  const h = hostOf(req);
  if (SHOP_DOMAINS.includes(h)) {
    // the customer address never shows the register or the admin panel
    if (/^\/(admin|index\.html|sw\.js|manifest\.webmanifest)(\/|$)/i.test(req.path)) return res.redirect(302, '/');
    if (req.path === '/' || req.path === '/pedir') return res.sendFile(path.join(__dirname, 'pedir.html'), { headers: { 'Cache-Control': 'no-cache' } });
  } else if (ADMIN_DOMAINS.includes(h)) {
    if (req.path === '/' || req.path === '/admin') return res.sendFile(path.join(__dirname, 'admin.html'), { headers: { 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' } });
  }
  next();
});
app.get('/admin/', (req, res, next) => (req.path.endsWith('/') ? res.redirect(301, '/admin') : next()));
// Never serve the server's own files or the data folder as static files.
app.use((req, res, next) => {
  if (/^\/(data|node_modules)(\/|$)|^\/(server\.js|package(-lock)?\.json)$/i.test(req.path)) return res.status(404).end();
  next();
});
app.use(express.static(__dirname, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('admin.html')) res.set('X-Robots-Tag', 'noindex, nofollow');
    if (filePath.endsWith('sw.js')) {
      res.set('Cache-Control', 'no-cache');
    } else if (filePath.includes(path.join(__dirname, 'icons'))) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  },
}));

// Photos and icons can also be uploaded as plain files with no folders (GitHub's upload page
// can't take folders): /photos/logo.png is then read from "photos-logo.png", /icons/x.png from "icons-x.png".
app.get(/^\/(photos|icons)\/([A-Za-z0-9_.-]+)$/, (req, res, next) => {
  const flat = path.join(__dirname, req.params[0] + '-' + req.params[1]);
  res.sendFile(flat, { headers: { 'Cache-Control': req.params[0] === 'icons' ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate' } }, (err) => { if (err) next(); });
});

// SPA fallback for any non-/api route (e.g. deep links) → index.html
app.get('*', (req, res) => {
  const h = hostOf(req);
  if (SHOP_DOMAINS.includes(h)) return res.sendFile(path.join(__dirname, 'pedir.html'));
  if (ADMIN_DOMAINS.includes(h)) return res.sendFile(path.join(__dirname, 'admin.html'));
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`RV Kitchen POS listening on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  if (!PERSISTENT) console.log('WARNING: data is NOT permanent. In Railway, add a Volume to this service so orders and accounts survive redeploys.');
  console.log(`Access code required: ${!!CODE}`);
});
