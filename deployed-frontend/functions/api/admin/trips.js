import { adminBody, adminDbUrl, adminFetch, requireAdmin } from '../../_lib/admin.js';
import { errorResponse, json } from '../../_lib/http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function tripInput(input) {
  const departure = new Date(input?.departure_at);
  if (!Number.isFinite(departure.getTime())) return null;
  const fare = Number(input?.fare_php);
  const capacity = Number(input?.capacity);
  const trip = {
    origin: clean(input?.origin, 120),
    destination: clean(input?.destination, 120),
    via: clean(input?.via || '', 250),
    departure_at: departure.toISOString(),
    fare_php: fare,
    capacity,
    state: input?.state === 'closed' ? 'closed' : 'open',
    is_public: input?.is_public !== false,
    notes: clean(input?.notes || '', 1000),
  };
  if (!trip.origin || !trip.destination || departure <= new Date()) return null;
  if (!Number.isInteger(fare) || fare < 0 || fare > 1000000 || !Number.isInteger(capacity) || capacity < 1 || capacity > 100) return null;
  return trip;
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const path = adminDbUrl(env, 'trips', `?select=id,origin,destination,via,departure_at,fare_php,capacity,state,is_public,notes,bookings(status)&departure_at=gte.${encodeURIComponent(since)}&order=departure_at.asc&limit=200`);
  const result = await adminFetch(env, path);
  if (!result.ok) return errorResponse('Could not load schedules.', 502);
  return json({ trips: await result.json() });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const input = await adminBody(request);
  const trip = input && tripInput(input);
  if (!trip) return errorResponse('Check route, future departure, fare, and capacity.', 400);
  trip.created_by = auth.user.id;
  const result = await adminFetch(env, adminDbUrl(env, 'trips'), {
    method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(trip),
  });
  if (!result.ok) return errorResponse('Could not save this schedule.', 502);
  return json({ trip: (await result.json())[0] }, 201);
}

export async function onRequestPatch({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const id = new URL(request.url).searchParams.get('id');
  if (!UUID.test(id || '')) return errorResponse('A valid schedule ID is required.', 400);
  const input = await adminBody(request);
  if (!input) return errorResponse('Send valid JSON schedule details.', 400);
  let updates;
  if (input.state === 'cancelled' || input.state === 'closed' || input.state === 'open') {
    updates = { state: input.state };
  } else {
    updates = tripInput(input);
    if (!updates) return errorResponse('Check route, future departure, fare, and capacity.', 400);
  }
  const result = await adminFetch(env, adminDbUrl(env, 'trips', `?id=eq.${id}`), {
    method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(updates),
  });
  if (!result.ok) return errorResponse('Could not update this schedule.', 502);
  const rows = await result.json();
  if (!rows.length) return errorResponse('Schedule not found.', 404);
  return json({ trip: rows[0] });
}
