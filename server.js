const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = 3000;

const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const ORG_DB_ID      = '35ec49b7-371e-476f-a9a2-bf5db46bff82';
const APP_PASSWORD   = process.env.APP_PASSWORD;          // set in EasyPanel
const AUTH_ENABLED   = !!APP_PASSWORD;
const COOKIE_SECRET  = 'taquion_cal_2025';

/* ─── Auth helpers ─── */
function makeToken(pw) {
  return crypto.createHash('sha256').update(pw + COOKIE_SECRET).digest('hex');
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  });
  return out;
}
function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  return parseCookies(req)['auth'] === makeToken(APP_PASSWORD);
}

/* ─── CORS ─── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ─── Body parser for login form ─── */
app.use(express.urlencoded({ extended: false }));

/* ─── Auth middleware ─── */
app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (req.path === '/login' || req.path === '/logout') return next();
  if (isAuthenticated(req)) return next();
  res.redirect('/login');
});

/* ─── Login page ─── */
app.get('/login', (req, res) => {
  const error = req.query.error;
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Acceso — Calendario de Proyectos</title>
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Nunito',sans-serif;background:#FDFCF0;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:24px;padding:44px 36px;width:380px;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,0.08);text-align:center}
    .icon{width:56px;height:56px;background:linear-gradient(135deg,#E3F2FD,#F3E5F5);border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;margin:0 auto 16px}
    h1{font-size:1.2rem;font-weight:800;color:#374151;margin-bottom:6px}
    .sub{font-size:0.8rem;color:#9CA3AF;font-weight:600;margin-bottom:28px}
    input[type=password]{width:100%;padding:12px 18px;border:1.5px solid #E5E7EB;border-radius:50px;font-family:'Nunito',sans-serif;font-size:0.88rem;font-weight:600;color:#374151;outline:none;margin-bottom:12px;background:#FDFCF0;transition:border-color .2s}
    input[type=password]:focus{border-color:#C4B5FD}
    button{width:100%;padding:12px;background:#374151;color:#fff;border:none;border-radius:50px;font-family:'Nunito',sans-serif;font-size:0.88rem;font-weight:800;cursor:pointer;transition:background .2s}
    button:hover{background:#1F2937}
    .error{margin-top:14px;color:#DC2626;font-size:0.76rem;font-weight:700;background:#FEF2F2;padding:8px 16px;border-radius:50px;display:inline-block}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📅</div>
    <h1>Calendario de Proyectos</h1>
    <p class="sub">Ingresá la contraseña para acceder</p>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Contraseña" autofocus autocomplete="current-password"/>
      <button type="submit">Ingresar →</button>
    </form>
    ${error ? '<p class="error">Contraseña incorrecta, intentá de nuevo</p>' : ''}
  </div>
</body>
</html>`);
});

/* ─── Login POST ─── */
app.post('/login', (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    const maxAge = 7 * 24 * 60 * 60; // 7 days
    res.setHeader('Set-Cookie',
      `auth=${makeToken(APP_PASSWORD)}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`
    );
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

/* ─── Logout ─── */
app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'auth=; HttpOnly; Max-Age=0; Path=/');
  res.redirect('/login');
});

/* ─── Static files ─── */
app.use(express.static(path.join(__dirname, 'public')));

/* ─── Notion fetch ─── */
async function fetchActiveOrgs() {
  const pages = [];
  let cursor;

  const filter = {
    and: [
      { property: 'Antiguo?', checkbox: { equals: false } },
      { property: 'Esta activa?', formula: { checkbox: { equals: true } } },
    ],
  };

  do {
    const body = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;

    const response = await fetch(`https://api.notion.com/v1/databases/${ORG_DB_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Notion API error: ${response.status} ${await response.text()}`);

    const data = await response.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return pages;
}

/* ─── Cache ─── */
let eventsCache = null;
let cacheTTL = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000;

/* ─── API ─── */
app.get('/api/events', async (req, res) => {
  try {
    const now = Date.now();
    if (eventsCache && now < cacheTTL) return res.json(eventsCache);

    const orgs = await fetchActiveOrgs();

    const FAR_FUTURE = new Date();
    FAR_FUTURE.setFullYear(FAR_FUTURE.getFullYear() + 2);

    const events = [];

    for (const org of orgs) {
      const props = org.properties;

      const name = props['Nombre']?.title?.[0]?.plain_text?.trim();
      if (!name) continue;
      if (/ANTIG[UÜ][AO]/i.test(name)) continue;

      const wonDates = (props['WON Date']?.rollup?.array || [])
        .map(x => x.date?.start).filter(Boolean).map(d => new Date(d));

      const deadlines = (props['Deadline']?.rollup?.array || [])
        .map(x => x.date?.start).filter(Boolean).map(d => new Date(d));

      const estados = (props['Estado Proyectos']?.rollup?.array || [])
        .map(x => x.status?.name || x.select?.name).filter(Boolean);

      if (wonDates.length === 0) continue;

      const startDate   = new Date(Math.min(...wonDates));
      const hasDeadline = deadlines.length > 0;
      const endDate     = hasDeadline ? new Date(Math.max(...deadlines)) : null;
      const calendarEnd = endDate ? new Date(endDate.getTime() + 86400000) : new Date(FAR_FUTURE);

      const color = estados.includes('En progreso') ? '#198754'
                  : estados.includes('Backlog')     ? '#fd7e14'
                  : '#6c757d';

      events.push({
        title: name,
        start: startDate.toISOString().split('T')[0],
        end:   calendarEnd.toISOString().split('T')[0],
        color,
        extendedProps: {
          estados:        [...new Set(estados)],
          projectCount:   wonDates.length,
          deadlineDisplay: endDate ? endDate.toISOString().split('T')[0] : null,
          wonDisplay:     startDate.toISOString().split('T')[0],
          noDeadline:     !hasDeadline,
        },
      });
    }

    events.sort((a, b) => new Date(b.start) - new Date(a.start));
    eventsCache = events;
    cacheTTL = now + CACHE_DURATION_MS;
    res.json(events);

  } catch (err) {
    console.error('Error fetching Notion data:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', (req, res) => {
  eventsCache = null;
  cacheTTL = 0;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n✅ Servidor corriendo en http://localhost:${PORT}`);
  if (AUTH_ENABLED) console.log('🔒 Autenticación activada');
  else console.log('⚠️  Sin contraseña (APP_PASSWORD no configurada)');
});
