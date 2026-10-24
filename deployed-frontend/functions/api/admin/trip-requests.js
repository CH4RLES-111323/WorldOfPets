import { adminBody, adminDbUrl, adminFetch, requireAdmin } from '../../_lib/admin.js';
import { errorResponse, json } from '../../_lib/http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(['pending', 'accepted', 'declined']);

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const path = adminDbUrl(env, 'trip_requests', '?select=id,reference_code,status,origin,destination,via,preferred_date,customer_name,customer_phone,pickup_address,dropoff_address,pet_type,breed,age,weight_kg,cage_option,created_at&order=created_at.desc&limit=200');
  const result = await adminFetch(env, path);
  if (!result.ok) return errorResponse('Could not load custom trip requests.', 502);
  return json({ requests: await result.json() });
}

export async function onRequestPatch({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const id = new URL(request.url).searchParams.get('id');
  const input = await adminBody(request, 1000);
  if (!UUID.test(id || '') || !input || !STATES.has(input.status)) return errorResponse('Choose a valid trip request and status.', 400);
  const result = await adminFetch(env, adminDbUrl(env, 'trip_requests', `?id=eq.${id}`), {
    method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: input.status }),
  });
  if (!result.ok) return errorResponse('Could not update this trip request.', 502);
  const rows = await result.json();
  if (!rows.length) return errorResponse('Trip request not found.', 404);
  return json({ request: rows[0] });
}
