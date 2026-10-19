// A stand-in for Core (Catalogue + Calendar) for the tests: a real HTTP server on a random local port, so the
// Core client (service key, timeout, retry) is exercised for real. Not a test file (no .test.js suffix).
//
// The calendar part is a small independent implementation of the working-time rules (fixture W: Tue-Fri 08:00-19:00,
// Sat 08:00-17:00, Sun and Mon closed; Asia/Manila is fixed UTC+08:00), so the expected numbers in the tests come from
// the rules and not from the code under test.
import { createServer } from 'node:http';

const MIN = 60_000;
const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const SCHEDULE_W = { 2: [480, 1140], 3: [480, 1140], 4: [480, 1140], 5: [480, 1140], 6: [480, 1020] };

const dayIndex = (ms) => Math.floor((ms + OFFSET) / DAY);
const weekday = (di) => (((di + 4) % 7) + 7) % 7;
const instantAt = (di, minute) => di * DAY + minute * MIN - OFFSET;
const pad = (n) => String(n).padStart(2, '0');

export function formatManila(ms) {
  const d = new Date(ms + OFFSET);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
}
export const at = (date, time = '00:00') => Date.parse(`${date}T${time}:00+08:00`);

export function engine(schedule = SCHEDULE_W) {
  const windowOf = (di) => {
    const w = schedule[weekday(di)];
    return w ? { open: w[0], close: w[1] } : null;
  };
  function workingMinutes(startMs, endMs) {
    let total = 0;
    for (let di = dayIndex(startMs); di <= dayIndex(endMs); di += 1) {
      const w = windowOf(di);
      if (!w) continue;
      const overlap = Math.min(endMs, instantAt(di, w.close)) - Math.max(startMs, instantAt(di, w.open));
      if (overlap > 0) total += overlap;
    }
    return Math.floor(total / MIN);
  }
  function advance(fromMs, minutes) {
    if (minutes === 0) return fromMs;
    let remaining = minutes;
    for (let di = dayIndex(fromMs); di <= dayIndex(fromMs) + 3660; di += 1) {
      const w = windowOf(di);
      if (!w) continue;
      const cursor = Math.max(fromMs, instantAt(di, w.open));
      const available = Math.floor((instantAt(di, w.close) - cursor) / MIN);
      if (available <= 0) continue;
      if (remaining <= available) return cursor + remaining * MIN;
      remaining -= available;
    }
    throw new Error('no working time');
  }
  function deadline(startMs, days, held = 0) {
    let counted = 0;
    for (let di = dayIndex(startMs) + 1; di < dayIndex(startMs) + 3660; di += 1) {
      const w = windowOf(di);
      if (!w) continue;
      counted += 1;
      if (counted === days) return advance(instantAt(di, w.close), held);
    }
    throw new Error('no working day');
  }
  return { workingMinutes, advance, deadline };
}

const errorBody = (code, message, details = null) => ({ error: { code, message, details, correlation_id: 'fake-core', timestamp: new Date().toISOString() } });

export async function startFakeCore({ serviceKey = 'test-service-key-0123456789' } = {}) {
  const cal = engine();
  const state = {
    calls: [],
    services: new Map(), // service_id -> { service_id, office_id, office_code, service_code, service_name, classification, is_active, standards: [{ from, to, standard_id, days, hours, minutes }] }
    offices: new Map(), // office_id -> { office_id, office_code, office_name, is_active }
    mode: 'up', // up | down (503) | drop (connection closed) | hang
    failures: 0, // fail this many requests (503) and then recover
    overrides: new Map(), // 'POST /working-minutes' -> (body) => { status, body }
  };

  const respond = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-core');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers };
    state.calls.push(call);

    if (state.mode === 'drop') return req.socket.destroy();
    if (state.mode === 'hang') return undefined; // never answers: the client times out
    if (state.mode === 'down') return respond(res, 503, errorBody('SERVICE_UNAVAILABLE', 'down'));
    if (state.failures > 0) {
      state.failures -= 1;
      return respond(res, 503, errorBody('SERVICE_UNAVAILABLE', 'down'));
    }
    if (req.headers['x-service-key'] !== serviceKey) return respond(res, 401, errorBody('INVALID_SERVICE_KEY', 'Service key required'));

    const override = state.overrides.get(`${req.method} ${url.pathname.replace(/^\/api/, '')}`);
    if (override) {
      const { status, body: out } = override(body, call);
      return respond(res, status, out);
    }

    let m = /^\/api\/services\/([^/]+)\/standard$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const service = state.services.get(m[1]);
      if (!service) return respond(res, 404, errorBody('SERVICE_NOT_FOUND', 'Service not found'));
      if (!service.is_active) return respond(res, 409, errorBody('SERVICE_INACTIVE', 'Service inactive'));
      const asOf = url.searchParams.get('asOf');
      const standard = service.standards.find((s) => s.from <= asOf && (!s.to || s.to >= asOf));
      if (!standard) return respond(res, 404, errorBody('STANDARD_NOT_FOUND', `No standard is in force for this service on ${asOf}`));
      return respond(res, 200, {
        standard_id: standard.standard_id,
        duration_days: standard.days,
        duration_hours: standard.hours,
        duration_minutes: standard.minutes,
        service_code: service.service_code,
        service_name: service.service_name,
        office_id: service.office_id,
        office_code: service.office_code,
        classification: service.classification,
      });
    }
    m = /^\/api\/offices\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const office = state.offices.get(m[1]);
      return office ? respond(res, 200, { office }) : respond(res, 404, errorBody('OFFICE_NOT_FOUND', 'Office not found'));
    }
    if (req.method === 'POST' && url.pathname === '/api/working-minutes') {
      const start = Date.parse(body.start);
      const end = Date.parse(body.end);
      if (!(end > start)) return respond(res, 400, errorBody('VALIDATION_ERROR', 'End must be after start', { end: 'End must be after start' }));
      return respond(res, 200, { working_minutes: cal.workingMinutes(start, end) });
    }
    if (req.method === 'POST' && url.pathname === '/api/deadline') {
      return respond(res, 200, { deadline: formatManila(cal.deadline(Date.parse(body.start), body.workingDays, body.heldMinutes ?? 0)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/add-working-minutes') {
      return respond(res, 200, { datetime: formatManila(cal.advance(Date.parse(body.datetime), body.minutes)) });
    }
    return respond(res, 404, errorBody('ROUTE_NOT_FOUND', 'Not found'));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    calls: state.calls,
    engine: cal,
    setMode(mode) { state.mode = mode; },
    failNext(n) { state.failures = n; },
    override(route, fn) { state.overrides.set(route, fn); },
    clearOverrides() { state.overrides.clear(); },
    reset() {
      state.calls.length = 0;
      state.mode = 'up';
      state.failures = 0;
      state.overrides.clear();
    },
    callsTo(method, pathPart) {
      return state.calls.filter((c) => c.method === method && c.path.includes(pathPart));
    },
    addOffice(office) { state.offices.set(office.office_id, { is_active: true, office_name: 'Office', ...office }); },
    addService(service) {
      const full = { is_active: true, classification: 'SIMPLE', standards: [], ...service };
      state.services.set(full.service_id, full);
      return full;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
