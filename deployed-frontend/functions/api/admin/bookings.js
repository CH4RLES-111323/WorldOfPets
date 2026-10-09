import { adminBody, adminDbUrl, adminFetch, requireAdmin } from '../../_lib/admin.js';
import { errorResponse, json } from '../../_lib/http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(['pending', 'confirmed', 'scheduled', 'in_transit', 'completed', 'cancelled', 'declined']);

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const path = adminDbUrl(env, 'bookings', '?select=id,reference_code,status,customer_name,customer_phone,pickup_address,dropoff_address,pet_type,breed,age,weight_kg,cage_option,total_php,created_at,trip:trips(origin,destination,departure_at)&order=created_at.desc&limit=200');
  const result = await adminFetch(env, path);
  if (!result.ok) return errorResponse('Could not load bookings.', 502);
  return json({ bookings: await result.json() });
}

export async function onRequestPatch({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const id = new URL(request.url).searchParams.get('id');
  const input = await adminBody(request, 1000);
  if (!UUID.test(id || '') || !input || !STATES.has(input.status)) return errorResponse('Choose a valid booking and status.', 400);
  const result = await adminFetch(env, adminDbUrl(env, 'bookings', `?id=eq.${id}`), {
    method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: input.status }),
  });
  if (!result.ok) return errorResponse('Could not update this booking.', 502);
  const rows = await result.json();
  if (!rows.length) return errorResponse('Booking not found.', 404);
  return json({ booking: rows[0] });
}
