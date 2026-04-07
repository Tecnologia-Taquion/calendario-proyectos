const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '22dd8d54553b45c2902448837ef16a13';

// Allow requests from the preview panel and local file opens
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

async function fetchAllNotionPages() {
  const pages = [];
  let cursor = undefined;

  // Filter at query time: only fetch projects with deadline >= 2026-01-01
  // OR projects that are active/backlog without any deadline
  const notionFilter = {
    or: [
      { property: 'Deadline', date: { on_or_after: '2026-01-01' } },
      {
        and: [
          { property: 'Deadline', date: { is_empty: true } },
          { property: 'Estado', status: { does_not_equal: 'Listo' } },
        ],
      },
    ],
  };

  do {
    const body = { page_size: 100, filter: notionFilter };
    if (cursor) body.start_cursor = cursor;

    const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
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

function extractAccountName(props, title) {
  // 1) Cuenta Formula (formula field derived from the Cuenta relation)
  const cuentaFormula = props['Cuenta Formula']?.formula?.string;
  if (cuentaFormula) return cuentaFormula.trim();

  // 2) Nombre rollup (rollup of the Cuenta relation title)
  const nombreArray = props['Nombre']?.rollup?.array;
  if (nombreArray && nombreArray.length > 0) {
    const text = nombreArray[0]?.title?.[0]?.plain_text;
    if (text) return text.trim();
  }

  // 3) Extract from task title: "Descripción + CLIENTE - FINALIZÓ" or "Descripción + CLIENTE"
  if (title) {
    const plusIdx = title.lastIndexOf('+');
    if (plusIdx !== -1) {
      let clientPart = title.slice(plusIdx + 1).trim();
      // Remove trailing status like "- FINALIZÓ", "- FINALIZO", "- EN PROGRESO", etc.
      clientPart = clientPart.replace(/\s*-\s*(FINALIZ[OÓ]|EN PROGRESO|BACKLOG|LISTO|DONE).*$/i, '').trim();
      if (clientPart.length > 0) return clientPart;
    }
  }

  return null;
}

// Cache to avoid hammering Notion on every request
let eventsCache = null;
let cacheTTL = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

app.get('/api/events', async (req, res) => {
  try {
    const now = Date.now();
    if (eventsCache && now < cacheTTL) {
      return res.json(eventsCache);
    }

    const pages = await fetchAllNotionPages();

    // Group projects by account name
    const accountMap = {};

    for (const page of pages) {
      const props = page.properties;
      const title = props['Tarea']?.title?.[0]?.plain_text || '';
      const accountName = extractAccountName(props, title);
      if (!accountName) continue;

      const wonRaw = props['Fecha WON']?.rollup?.array?.[0]?.date?.start;
      const deadlineRaw = props['Deadline']?.date?.start;

      if (!wonRaw && !deadlineRaw) continue;

      if (!accountMap[accountName]) {
        accountMap[accountName] = {
          name: accountName,
          wonDates: [],
          deadlines: [],
          estados: new Set(),
        };
      }

      if (wonRaw) accountMap[accountName].wonDates.push(new Date(wonRaw));
      if (deadlineRaw) accountMap[accountName].deadlines.push(new Date(deadlineRaw));

      const estado = props['Estado']?.status?.name;
      if (estado) accountMap[accountName].estados.add(estado);
    }

    // Build FullCalendar events: one per account
    const CUTOFF = new Date('2026-01-01');
    // "Infinite" end: 2 years from now, used for no-deadline accounts
    const FAR_FUTURE = new Date();
    FAR_FUTURE.setFullYear(FAR_FUTURE.getFullYear() + 2);
    const events = [];

    for (const acc of Object.values(accountMap)) {
      if (acc.wonDates.length === 0) continue;

      const hasDeadline = acc.deadlines.length > 0;
      const latestDeadline = hasDeadline ? new Date(Math.max(...acc.deadlines)) : null;

      // Skip if ALL deadlines are before cutoff (no active/future work)
      if (hasDeadline && latestDeadline < CUTOFF) continue;

      const startDate = new Date(Math.min(...acc.wonDates));
      const endDate = hasDeadline ? latestDeadline : null;

      // For FullCalendar: infinite accounts get FAR_FUTURE as end
      const calendarEnd = endDate ? new Date(endDate.getTime() + 86400000) : new Date(FAR_FUTURE);

      const estados = [...acc.estados];
      let color;
      if (estados.every(e => e === 'Listo')) {
        color = '#6c757d';
      } else if (estados.includes('En progreso')) {
        color = '#198754';
      } else {
        color = '#fd7e14';
      }

      events.push({
        title: acc.name,
        start: startDate.toISOString().split('T')[0],
        end: calendarEnd.toISOString().split('T')[0],
        color,
        extendedProps: {
          estados,
          projectCount: acc.wonDates.length,
          deadlineDisplay: endDate ? endDate.toISOString().split('T')[0] : null,
          wonDisplay: startDate.toISOString().split('T')[0],
          noDeadline: !hasDeadline,
        },
      });
    }

    // Sort by start date descending
    events.sort((a, b) => new Date(b.start) - new Date(a.start));

    eventsCache = events;
    cacheTTL = now + CACHE_DURATION_MS;

    res.json(events);
  } catch (err) {
    console.error('Error fetching Notion data:', err);
    res.status(500).json({ error: err.message });
  }
});

// Force cache refresh
app.post('/api/refresh', (req, res) => {
  eventsCache = null;
  cacheTTL = 0;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n✅ Servidor corriendo en http://localhost:${PORT}\n`);
});
