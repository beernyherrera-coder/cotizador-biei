const fs = require('fs');
const path = require('path');
const ical = require('node-ical');

const TZ = 'America/Argentina/Buenos_Aires';
const DAYS_AHEAD = 14;

const STUDIOS = [
  { key: 'CAL_ICS_ESTUDIO1', label: 'Estudio 1' },
  { key: 'CAL_ICS_ESTUDIO2', label: 'Estudio 2' },
  { key: 'CAL_ICS_ESTUDIO3', label: 'Estudio 3' },
  { key: 'CAL_ICS_ESTUDIO4', label: 'Estudio 4' },
];

function fmtDateKey(d) {
  // YYYY-MM-DD in Buenos Aires time, used for grouping/sorting
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const o = {};
  parts.forEach(p => { o[p.type] = p.value; });
  return `${o.year}-${o.month}-${o.day}`;
}

function fmtDateShort(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const o = {};
  parts.forEach(p => { o[p.type] = p.value; });
  return `${o.day}/${o.month}`;
}

function fmtTime(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

function cleanName(summary) {
  if (!summary) return null;
  let s = String(summary).trim();
  s = s.replace(/^\[SpacePal\]\s*-\s*/i, '');
  s = s.replace(/^E[1-4]\s*[-.]?\s*/i, '');
  s = s.replace(/\s*E[1-4]\s*$/i, '');
  s = s.trim();
  if (!s) return null;
  return s.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase());
}

async function collectEventsForCalendar(url, rangeStart, rangeEnd) {
  const data = await ical.async.fromURL(url);
  const collected = [];

  for (const k in data) {
    const ev = data[k];
    if (!ev || ev.type !== 'VEVENT') continue;
    if (ev.transparency === 'TRANSPARENT') continue;

    if (ev.rrule) {
      let dates = [];
      try {
        dates = ev.rrule.between(rangeStart, rangeEnd, true);
      } catch (e) { dates = []; }

      const duration = ev.end && ev.start ? (ev.end.getTime() - ev.start.getTime()) : 0;

      for (const occStart of dates) {
        const dateKey = fmtDateKey(occStart);
        let start = occStart;
        let end = new Date(occStart.getTime() + duration);
        let summary = ev.summary;
        let skip = false;

        if (ev.exdate) {
          for (const exKey in ev.exdate) {
            if (fmtDateKey(ev.exdate[exKey]) === dateKey) { skip = true; break; }
          }
        }
        if (skip) continue;

        if (ev.recurrences) {
          for (const recKey in ev.recurrences) {
            if (fmtDateKey(new Date(recKey)) === dateKey) {
              const rec = ev.recurrences[recKey];
              start = rec.start; end = rec.end; summary = rec.summary;
            }
          }
        }
        if (start < rangeStart || start > rangeEnd) continue;
        collected.push({ start, end, summary });
      }
    } else if (ev.start) {
      if (ev.start >= rangeStart && ev.start <= rangeEnd) {
        collected.push({ start: ev.start, end: ev.end || ev.start, summary: ev.summary });
      }
    }
  }
  return collected;
}

function buildColumnHtml(events) {
  if (events.length === 0) {
    return '<p class="avail-empty">Sin reservas registradas</p>';
  }
  const byDate = {};
  for (const e of events) {
    const key = fmtDateKey(e.start);
    if (!byDate[key]) byDate[key] = { dateShort: fmtDateShort(e.start), items: [] };
    byDate[key].items.push({
      start: e.start,
      text: `${fmtTime(e.start)}–${fmtTime(e.end)}${cleanName(e.summary) ? ' (' + cleanName(e.summary) + ')' : ''}`,
    });
  }
  const sortedKeys = Object.keys(byDate).sort();
  const items = sortedKeys.map(k => {
    const d = byDate[k];
    d.items.sort((a, b) => a.start - b.start);
    return `      <li><b>${d.dateShort}</b> ${d.items.map(i => i.text).join(', ')}</li>`;
  });
  return `<ul>\n${items.join('\n')}\n    </ul>`;
}

async function main() {
  const rangeStart = new Date();
  const rangeEnd = new Date(rangeStart.getTime() + DAYS_AHEAD * 86400000);

  const columns = [];
  for (const studio of STUDIOS) {
    const url = process.env[studio.key];
    if (!url) {
      columns.push(`    <div class="avail-col"><h3>${studio.label}</h3><p class="avail-empty">No configurado</p></div>`);
      continue;
    }
    try {
      const events = await collectEventsForCalendar(url, rangeStart, rangeEnd);
      const html = buildColumnHtml(events);
      columns.push(`    <div class="avail-col"><h3>${studio.label}</h3>${html}</div>`);
    } catch (e) {
      console.error(`Error fetching ${studio.label}:`, e.message);
      columns.push(`    <div class="avail-col"><h3>${studio.label}</h3><p class="avail-empty">Error al cargar</p></div>`);
    }
  }

  const updatedStr = new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date());

  const block = `<!-- AVAILABILITY:START -->
<div class="avail">
  <h2>Disponibilidad — próximos 14 días</h2>
  <div class="updated">Actualizado: ${updatedStr}</div>
  <div class="avail-grid">
${columns.join('\n')}
  </div>
</div>
<!-- AVAILABILITY:END -->`;

  const indexPath = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const re = /<!-- AVAILABILITY:START -->[\s\S]*?<!-- AVAILABILITY:END -->/;
  if (!re.test(html)) {
    console.error('AVAILABILITY markers not found in index.html');
    process.exit(1);
  }
  const newHtml = html.replace(re, block);
  fs.writeFileSync(indexPath, newHtml, 'utf8');
  console.log('index.html updated.');
}

main().catch(e => { console.error(e); process.exit(1); });
