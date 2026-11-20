'use strict';
// Servidor de Lecturas Pintolindo: sirve la app y guarda los datos en PostgreSQL.
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SECRET = process.env.SESSION_SECRET;
const ADMIN_PIN = process.env.ADMIN_PIN;
if (!DATABASE_URL) { console.error('Falta la variable DATABASE_URL.'); process.exit(1); }
if (!SECRET || SECRET.length < 16) { console.error('Falta la variable SESSION_SECRET (al menos 16 caracteres).'); process.exit(1); }

const usaSSL = !/railway\.internal|localhost|127\.0\.0\.1/.test(DATABASE_URL) && process.env.PGSSL !== 'disable';
const pool = new Pool({ connectionString: DATABASE_URL, ssl: usaSSL ? { rejectUnauthorized: false } : false, max: 5 });

const TIPOS = new Set(['salida', 'recepcion', 'inventario']);
const norm = s => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
const limpio = (s, max = 200) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/* ---------- PIN y sesiones ---------- */
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function pinOk(pin, guardado) {
  const [s, h] = String(guardado).split(':');
  if (!s || !h) return false;
  const calc = crypto.scryptSync(String(pin), Buffer.from(s, 'hex'), 32);
  const esp = Buffer.from(h, 'hex');
  return calc.length === esp.length && crypto.timingSafeEqual(calc, esp);
}
const pinValido = pin => /^\d{4,8}$/.test(String(pin ?? ''));
const firmar = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function crearToken(u) {
  const data = Buffer.from(JSON.stringify({ u: u.id, v: u.token_ver, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString('base64url');
  return data + '.' + firmar(data);
}
function leerToken(t) {
  const [data, sig] = String(t || '').split('.');
  if (!data || !sig) return null;
  const esperada = firmar(data);
  if (sig.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperada))) return null;
  try { const p = JSON.parse(Buffer.from(data, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}

/* ---------- Base de datos ---------- */
async function iniciarBase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, nombre_norm TEXT UNIQUE NOT NULL,
      pin_hash TEXT NOT NULL, rol TEXT NOT NULL DEFAULT 'operador', activo BOOLEAN NOT NULL DEFAULT TRUE,
      token_ver INT NOT NULL DEFAULT 1, creado TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS depositos (
      id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, nombre_norm TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS catalogo (
      id INT PRIMARY KEY DEFAULT 1, version INT NOT NULL, archivo TEXT, importado TIMESTAMPTZ NOT NULL DEFAULT now(),
      importado_por TEXT, items JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS lecturas (
      id TEXT PRIMARY KEY, tipo TEXT NOT NULL, origen TEXT NOT NULL, destino TEXT, persona TEXT NOT NULL,
      usuario_id INT REFERENCES usuarios(id), ref TEXT, inicio TIMESTAMPTZ NOT NULL, fin TIMESTAMPTZ,
      lines JSONB NOT NULL DEFAULT '[]', actualizado TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS lecturas_inicio ON lecturas (inicio DESC);
    ALTER TABLE lecturas ADD COLUMN IF NOT EXISTS salidas JSONB NOT NULL DEFAULT '[]';
  `);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM usuarios');
  if (rows[0].n === 0) {
    if (!pinValido(ADMIN_PIN)) { console.error('No hay usuarios. Definí ADMIN_PIN (4 a 8 números) para crear el usuario Administrador.'); return; }
    await pool.query("INSERT INTO usuarios (nombre, nombre_norm, pin_hash, rol) VALUES ('Administrador', 'administrador', $1, 'admin')", [hashPin(ADMIN_PIN)]);
    console.log('Usuario Administrador creado.');
  } else if (process.env.RESET_ADMIN_PIN === 'si' && pinValido(ADMIN_PIN)) {
    await pool.query("UPDATE usuarios SET pin_hash=$1, activo=TRUE, rol='admin', token_ver=token_ver+1 WHERE nombre_norm='administrador'", [hashPin(ADMIN_PIN)]);
    console.log('PIN del Administrador restablecido. Quitá la variable RESET_ADMIN_PIN.');
  }
}

/* ---------- App ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); next(); });
app.use('/api', express.json({ limit: '25mb' }));

const envolver = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function auth(req, res, next) {
  const p = leerToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!p) return res.status(401).json({ error: 'Tu sesión venció. Volvé a ingresar.' });
  const { rows } = await pool.query('SELECT id, nombre, rol, activo, token_ver FROM usuarios WHERE id=$1', [p.u]);
  const u = rows[0];
  if (!u || !u.activo || u.token_ver !== p.v) return res.status(401).json({ error: 'Tu sesión ya no es válida. Volvé a ingresar.' });
  req.usuario = u; next();
}
const soloAdmin = (req, res, next) => req.usuario.rol === 'admin' ? next() : res.status(403).json({ error: 'Solo un administrador puede hacer esto.' });
const pub = u => ({ id: u.id, nombre: u.nombre, rol: u.rol });

/* Ingreso con nombre y PIN, con bloqueo tras varios intentos fallidos */
const intentos = new Map();
app.post('/api/login', envolver(async (req, res) => {
  const nombre = norm(req.body.nombre), clave = `${req.ip}|${nombre}`;
  const it = intentos.get(clave) || { n: 0, hasta: 0 };
  if (it.hasta > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Esperá 5 minutos y probá de nuevo.' });
  const { rows } = await pool.query('SELECT * FROM usuarios WHERE nombre_norm=$1 AND activo', [nombre]);
  const u = rows[0];
  if (!u || !pinOk(req.body.pin, u.pin_hash)) {
    it.n++; if (it.n >= 5) { it.n = 0; it.hasta = Date.now() + 5 * 60 * 1000; }
    intentos.set(clave, it);
    return res.status(401).json({ error: 'Nombre o PIN incorrecto.' });
  }
  intentos.delete(clave);
  res.json({ token: crearToken(u), usuario: pub(u) });
}));

app.use('/api', envolver(auth));

/* Datos de arranque: usuario, depósitos, responsables y catálogo (solo si cambió) */
app.get('/api/datos', envolver(async (req, res) => {
  const [dep, per, cat] = await Promise.all([
    pool.query('SELECT id, nombre FROM depositos ORDER BY nombre'),
    pool.query('SELECT nombre FROM usuarios WHERE activo ORDER BY nombre'),
    pool.query('SELECT version, archivo, importado, importado_por FROM catalogo WHERE id=1')
  ]);
  let catalogo = null;
  if (cat.rows[0]) {
    const c = cat.rows[0];
    if (String(c.version) === String(req.query.cv)) catalogo = { version: c.version, sinCambios: true };
    else {
      const { rows } = await pool.query('SELECT items FROM catalogo WHERE id=1');
      catalogo = { version: c.version, archivo: c.archivo, importado: c.importado, importadoPor: c.importado_por, items: rows[0].items };
    }
  }
  res.json({ usuario: pub(req.usuario), depositos: dep.rows, personas: per.rows.map(r => r.nombre), catalogo });
}));

/* Catálogo */
function limpiarItems(items) {
  if (!Array.isArray(items)) return null;
  const out = [];
  for (const it of items.slice(0, 200000)) {
    const c = limpio(it?.c, 80), d = limpio(it?.d, 300);
    const b = Array.isArray(it?.b) ? it.b.map(x => limpio(x, 80)).filter(Boolean).slice(0, 20) : [];
    if (c || b.length) out.push({ c, b, d: d || c || b[0] });
  }
  return out;
}
app.put('/api/catalogo', soloAdmin, envolver(async (req, res) => {
  const items = limpiarItems(req.body.items);
  if (!items || !items.length) return res.status(400).json({ error: 'El catálogo no tiene artículos válidos.' });
  const { rows } = await pool.query(`
    INSERT INTO catalogo (id, version, archivo, importado, importado_por, items) VALUES (1, 1, $1, now(), $2, $3)
    ON CONFLICT (id) DO UPDATE SET version = catalogo.version + 1, archivo = $1, importado = now(), importado_por = $2, items = $3
    RETURNING version, archivo, importado, importado_por`, [limpio(req.body.archivo, 200), req.usuario.nombre, JSON.stringify(items)]);
  res.json({ ...rows[0], importadoPor: rows[0].importado_por, items });
}));

/* Depósitos */
app.post('/api/depositos', soloAdmin, envolver(async (req, res) => {
  const nombre = limpio(req.body.nombre, 80);
  if (!nombre) return res.status(400).json({ error: 'Escribí el nombre del depósito.' });
  const r = await pool.query('INSERT INTO depositos (nombre, nombre_norm) VALUES ($1, $2) ON CONFLICT (nombre_norm) DO NOTHING RETURNING id', [nombre, norm(nombre)]);
  if (!r.rowCount) return res.status(409).json({ error: 'Ese depósito ya existe.' });
  const { rows } = await pool.query('SELECT id, nombre FROM depositos ORDER BY nombre'); res.json(rows);
}));
app.delete('/api/depositos/:id', soloAdmin, envolver(async (req, res) => {
  await pool.query('DELETE FROM depositos WHERE id=$1', [+req.params.id || 0]);
  const { rows } = await pool.query('SELECT id, nombre FROM depositos ORDER BY nombre'); res.json(rows);
}));

/* Usuarios */
const listaUsuarios = async () => (await pool.query('SELECT id, nombre, rol, activo FROM usuarios ORDER BY activo DESC, nombre')).rows;
app.get('/api/usuarios', soloAdmin, envolver(async (req, res) => res.json(await listaUsuarios())));
app.post('/api/usuarios', soloAdmin, envolver(async (req, res) => {
  const nombre = limpio(req.body.nombre, 80), rol = req.body.rol === 'admin' ? 'admin' : 'operador';
  if (!nombre) return res.status(400).json({ error: 'Escribí el nombre.' });
  if (!pinValido(req.body.pin)) return res.status(400).json({ error: 'El PIN tiene que tener entre 4 y 8 números.' });
  const r = await pool.query('INSERT INTO usuarios (nombre, nombre_norm, pin_hash, rol) VALUES ($1,$2,$3,$4) ON CONFLICT (nombre_norm) DO NOTHING RETURNING id', [nombre, norm(nombre), hashPin(req.body.pin), rol]);
  if (!r.rowCount) return res.status(409).json({ error: 'Ya hay un usuario con ese nombre.' });
  res.json(await listaUsuarios());
}));
app.patch('/api/usuarios/:id', soloAdmin, envolver(async (req, res) => {
  const id = +req.params.id || 0;
  const { rows } = await pool.query('SELECT * FROM usuarios WHERE id=$1', [id]);
  const u = rows[0]; if (!u) return res.status(404).json({ error: 'No existe ese usuario.' });
  const quitaAdmin = (req.body.activo === false || req.body.rol === 'operador') && u.rol === 'admin';
  if (quitaAdmin) {
    const { rows: a } = await pool.query("SELECT count(*)::int AS n FROM usuarios WHERE rol='admin' AND activo AND id<>$1", [id]);
    if (a[0].n === 0) return res.status(400).json({ error: 'Tiene que quedar al menos un administrador activo.' });
  }
  if (req.body.pin !== undefined) {
    if (!pinValido(req.body.pin)) return res.status(400).json({ error: 'El PIN tiene que tener entre 4 y 8 números.' });
    await pool.query('UPDATE usuarios SET pin_hash=$1, token_ver=token_ver+1 WHERE id=$2', [hashPin(req.body.pin), id]);
  }
  if (typeof req.body.activo === 'boolean') await pool.query('UPDATE usuarios SET activo=$1, token_ver=token_ver+1 WHERE id=$2', [req.body.activo, id]);
  if (req.body.rol === 'admin' || req.body.rol === 'operador') await pool.query('UPDATE usuarios SET rol=$1 WHERE id=$2', [req.body.rol, id]);
  res.json(await listaUsuarios());
}));

/* Lecturas */
function limpiarLineas(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, 20000).map(l => ({
    k: limpio(l?.k, 120), c: limpio(l?.c, 80), b: limpio(l?.b, 80), d: limpio(l?.d, 300),
    q: Math.max(0, Math.min(1e7, parseInt(l?.q, 10) || 0)), nc: !!l?.nc,
    t: l?.t ? new Date(l.t).toISOString() : null, u: l?.u ? new Date(l.u).toISOString() : null
  })).filter(l => l.k && l.q > 0);
}
const fechaOk = v => v && !isNaN(new Date(v)) ? new Date(v).toISOString() : null;
const filaALectura = r => ({ id: r.id, tipo: r.tipo, origen: r.origen, destino: r.destino || '', persona: r.persona, usuarioId: r.usuario_id, ref: r.ref || '', inicio: r.inicio, fin: r.fin, lines: r.lines, salidas: r.salidas || [], actualizado: r.actualizado });

/* Control de traslados: compara una recepción con la suma de sus salidas vinculadas */
function comparar(recepcion, salidas) {
  const env = new Map(), rec = new Map(), meta = new Map();
  for (const s of salidas) for (const l of s.lines) { env.set(l.k, (env.get(l.k) || 0) + l.q); if (!meta.has(l.k)) meta.set(l.k, l); }
  for (const l of recepcion.lines) { rec.set(l.k, (rec.get(l.k) || 0) + l.q); if (!meta.has(l.k)) meta.set(l.k, l); }
  return [...new Set([...env.keys(), ...rec.keys()])].map(k => {
    const e = env.get(k) || 0, r = rec.get(k) || 0;
    return { k, estado: e === r ? 'ok' : e === 0 ? 'noenviado' : r < e ? 'faltante' : 'sobrante' };
  });
}
const idValido = id => typeof id === 'string' && /^[A-Za-z0-9-]{1,60}$/.test(id);
async function enriquecer(lects) {
  const salIds = lects.filter(l => l.tipo === 'salida').map(l => l.id);
  const recs = new Map(lects.filter(l => l.tipo === 'recepcion' && l.salidas.length).map(l => [l.id, l]));
  if (salIds.length) {
    const { rows } = await pool.query("SELECT * FROM lecturas WHERE tipo='recepcion' AND salidas ?| $1::text[]", [salIds]);
    rows.map(filaALectura).forEach(r => { if (!recs.has(r.id)) recs.set(r.id, r); });
  }
  const necesarias = [...new Set([...recs.values()].flatMap(r => r.salidas))];
  const salMap = new Map();
  if (necesarias.length) (await pool.query('SELECT * FROM lecturas WHERE id = ANY($1::text[])', [necesarias])).rows.forEach(r => salMap.set(r.id, filaALectura(r)));
  const resumen = new Map();
  for (const r of recs.values()) {
    const ss = r.salidas.map(id => salMap.get(id)).filter(Boolean);
    resumen.set(r.id, { diferencias: comparar(r, ss).filter(f => f.estado !== 'ok').length, salidas: ss.length });
  }
  for (const l of lects) {
    if (l.tipo === 'recepcion' && l.salidas.length) l.control = resumen.get(l.id);
    if (l.tipo === 'salida') {
      const r = [...recs.values()].find(x => x.salidas.includes(l.id));
      l.recepcion = r ? { id: r.id, fin: r.fin, inicio: r.inicio, persona: r.persona, diferencias: resumen.get(r.id).diferencias } : null;
    }
  }
  return lects;
}

/* Salidas hacia un depósito que todavía no tienen recepción */
app.get('/api/salidas-pendientes', envolver(async (req, res) => {
  const destino = limpio(req.query.destino, 80), propia = idValido(req.query.recepcion) ? req.query.recepcion : '';
  const { rows } = await pool.query(`
    SELECT * FROM lecturas l WHERE l.tipo='salida' AND l.fin IS NOT NULL AND l.destino=$1
      AND (l.inicio > now() - interval '120 days' OR EXISTS (SELECT 1 FROM lecturas r WHERE r.id=$2 AND r.salidas ? l.id))
      AND NOT EXISTS (SELECT 1 FROM lecturas r WHERE r.tipo='recepcion' AND r.salidas ? l.id AND r.id <> $2)
    ORDER BY l.inicio DESC LIMIT 100`, [destino, propia]);
  res.json(rows.map(filaALectura).map(l => ({ ...l, articulos: l.lines.length, unidades: l.lines.reduce((a, x) => a + x.q, 0), lines: undefined })));
}));

app.get('/api/lecturas', envolver(async (req, res) => {
  const cond = [], p = [];
  const add = (sql, v) => { p.push(v); cond.push(sql.replace('?', '$' + p.length)); };
  if (fechaOk(req.query.desde)) add('inicio >= ?', fechaOk(req.query.desde));
  if (fechaOk(req.query.hasta)) add('inicio <= ?', fechaOk(req.query.hasta));
  if (TIPOS.has(req.query.tipo)) add('tipo = ?', req.query.tipo);
  if (req.query.deposito) { p.push(req.query.deposito); cond.push(`(origen = $${p.length} OR destino = $${p.length})`); }
  if (req.query.persona) add('persona = ?', req.query.persona);
  if (req.query.ids) add('id = ANY(?::text[])', String(req.query.ids).split(',').filter(idValido).slice(0, 100));
  const limite = Math.min(2000, Math.max(1, parseInt(req.query.limite, 10) || 500));
  const { rows } = await pool.query(`SELECT * FROM lecturas ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY inicio DESC LIMIT ${limite}`, p);
  res.json(await enriquecer(rows.map(filaALectura)));
}));

app.put('/api/lecturas/:id', envolver(async (req, res) => {
  const id = limpio(req.params.id, 60), b = req.body, yo = req.usuario;
  if (!/^[A-Za-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'Identificador inválido.' });
  if (!TIPOS.has(b.tipo) || !limpio(b.origen) || !fechaOk(b.inicio)) return res.status(400).json({ error: 'Faltan datos de la lectura.' });
  const { rows } = await pool.query('SELECT usuario_id, actualizado FROM lecturas WHERE id=$1', [id]);
  const ex = rows[0];
  if (ex && ex.usuario_id !== yo.id && yo.rol !== 'admin') return res.status(403).json({ error: 'Esta lectura es de otro usuario.' });
  const act = fechaOk(b.actualizado) || new Date().toISOString();
  if (ex && new Date(ex.actualizado) > new Date(act)) return res.json({ ok: true, ignorada: true });
  const salidas = b.tipo === 'recepcion' && Array.isArray(b.salidas) ? [...new Set(b.salidas.filter(idValido))].slice(0, 50) : [];
  const vals = [id, b.tipo, limpio(b.origen, 80), limpio(b.destino, 80) || null, limpio(b.ref, 120) || null, fechaOk(b.inicio), fechaOk(b.fin), JSON.stringify(limpiarLineas(b.lines)), act, JSON.stringify(salidas)];
  if (ex) await pool.query('UPDATE lecturas SET tipo=$2, origen=$3, destino=$4, ref=$5, inicio=$6, fin=$7, lines=$8, actualizado=$9, salidas=$10 WHERE id=$1', vals);
  else await pool.query('INSERT INTO lecturas (id, tipo, origen, destino, ref, inicio, fin, lines, actualizado, salidas, persona, usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [...vals, yo.nombre, yo.id]);
  res.json({ ok: true });
}));

app.delete('/api/lecturas/:id', envolver(async (req, res) => {
  const { rows } = await pool.query('SELECT usuario_id FROM lecturas WHERE id=$1', [req.params.id]);
  if (rows[0] && rows[0].usuario_id !== req.usuario.id && req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo quien hizo la lectura o un administrador puede eliminarla.' });
  await pool.query('DELETE FROM lecturas WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* Importar una copia de seguridad de la versión anterior (solo en el teléfono) */
app.post('/api/importar-copia', soloAdmin, envolver(async (req, res) => {
  const c = req.body.copia || {};
  if (c.app !== 'pintolindo-lecturas') return res.status(400).json({ error: 'Ese archivo no es una copia de esta app.' });
  let deps = 0, lects = 0, arts = 0;
  for (const n of (c.config?.depositos || [])) {
    const nombre = limpio(n, 80); if (!nombre) continue;
    const r = await pool.query('INSERT INTO depositos (nombre, nombre_norm) VALUES ($1,$2) ON CONFLICT DO NOTHING', [nombre, norm(nombre)]); deps += r.rowCount;
  }
  const items = limpiarItems(c.catalog?.items);
  if (items && items.length && req.body.reemplazarCatalogo) {
    await pool.query(`INSERT INTO catalogo (id, version, archivo, importado, importado_por, items) VALUES (1, 1, $1, now(), $2, $3)
      ON CONFLICT (id) DO UPDATE SET version = catalogo.version + 1, archivo = $1, importado = now(), importado_por = $2, items = $3`,
      [limpio(c.catalog.archivo, 200) || 'copia de seguridad', req.usuario.nombre, JSON.stringify(items)]);
    arts = items.length;
  }
  for (const s of (c.sessions || [])) {
    if (!/^[A-Za-z0-9-]+$/.test(String(s.id)) || !TIPOS.has(s.tipo) || !fechaOk(s.inicio)) continue;
    const r = await pool.query(`INSERT INTO lecturas (id, tipo, origen, destino, ref, inicio, fin, lines, actualizado, persona)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.tipo, limpio(s.origen, 80), limpio(s.destino, 80) || null, limpio(s.ref, 120) || null, fechaOk(s.inicio), fechaOk(s.fin) || fechaOk(s.inicio), JSON.stringify(limpiarLineas(s.lines)), limpio(s.persona, 80) || 'Sin dato']);
    lects += r.rowCount;
  }
  res.json({ depositos: deps, lecturas: lects, articulos: arts });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));

/* Archivos de la app (solo los de esta lista) */
const ARCHIVOS = ['index.html', 'sw.js', 'manifest.webmanifest', 'html5-qrcode.min.js', 'xlsx.full.min.js', 'jspdf.umd.min.js',
  'jspdf.plugin.autotable.min.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'plantilla_catalogo.csv'];
const enviar = (f, res) => {
  res.set('Cache-Control', /\.(html|js|webmanifest)$/.test(f) && !f.endsWith('.min.js') ? 'no-cache' : 'public, max-age=86400');
  res.sendFile(path.join(__dirname, f));
};
app.get('/', (req, res) => enviar('index.html', res));
for (const f of ARCHIVOS) app.get('/' + f, (req, res) => enviar(f, res));
app.get('/salud', (req, res) => res.send('ok'));

app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es demasiado grande.' });
  res.status(500).json({ error: 'Error del servidor. Probá de nuevo en un momento.' });
});

iniciarBase()
  .then(() => app.listen(PORT, () => console.log(`Lecturas Pintolindo escuchando en el puerto ${PORT}`)))
  .catch(err => { console.error('No se pudo preparar la base de datos:', err); process.exit(1); });
