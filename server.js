const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ORG_DB_ID = '35ec49b7-371e-476f-a9a2-bf5db46bff82'; // Registro de Organizaciones

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Fetch all active, non-antiguo accounts from Registro de Organizaciones
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

    if (!response.ok) {
      throw new Error(`Notion API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return pages;
}

let eventsCache = null;
let cacheTTL = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

app.get('/api/events', async (req, res) => {
  try {
    const now = Date.now();
    if (eventsCache && now < cacheTTL) {
      return res.json(eventsCache);
    }

    const orgs = await fetchActiveOrgs();

    const FAR_FUTURE = new Date();
    FAR_FUTURE.setFullYear(FAR_FUTURE.getFullYear() + 2);

    const events = [];

    for (const org of orgs) {
      const props = org.properties;

      // Account name — skip if contains ANTIGUO/ANTIGUA (double check)
      const name = props['Nombre']?.title?.[0]?.plain_text?.trim();
      if (!name) continue;
      if (/ANTIG[UÜ][AO]/i.test(name)) continue;

      // WON dates — rollup array of date objects (one per opportunity)
      const wonDates = (props['WON Date']?.rollup?.array || [])
        .map(x => x.date?.start)
        .filter(Boolean)
        .map(d => new Date(d));

      // Deadlines — rollup array of date objects (one per delivery project)
      const deadlines = (props['Deadline']?.rollup?.array || [])
        .map(x => x.date?.start)
        .filter(Boolean)
        .map(d => new Date(d));

      // Estados — rollup of the "Estado" status field from Squad Cuentas projects
      const estados = (props['Estado Proyectos']?.rollup?.array || [])
        .map(x => x.status?.name || x.select?.name)
        .filter(Boolean);

      // Need at least a WON date to plot the event
      if (wonDates.length === 0) continue;

      const startDate = new Date(Math.min(...wonDates));
      const hasDeadline = deadlines.length > 0;
      const endDate = hasDeadline ? new Date(Math.max(...deadlines)) : null;

      // Calendar end (FullCalendar all-day end is exclusive → +1 day)
      const calendarEnd = endDate
        ? new Date(endDate.getTime() + 86400000)
        : new Date(FAR_FUTURE);

      // Color by active status
      let color;
      if (estados.includes('En progreso')) {
        color = '#198754'; // green
      } else if (estados.includes('Backlog')) {
        color = '#fd7e14'; // orange
      } else {
        color = '#6c757d'; // gray fallback
      }

      events.push({
        title: name,
        start: startDate.toISOString().split('T')[0],
        end: calendarEnd.toISOString().split('T')[0],
        color,
        extendedProps: {
          estados: [...new Set(estados)],
          projectCount: wonDates.length,
          deadlineDisplay: endDate ? endDate.toISOString().split('T')[0] : null,
          wonDisplay: startDate.toISOString().split('T')[0],
          noDeadline: !hasDeadline,
        },
      });
    }

    // Sort by start date descending (most recent first)
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
  console.log(`\n✅ Servidor corriendo en http://localhost:${PORT}\n`);
});
