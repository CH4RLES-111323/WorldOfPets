import { adminBody, adminDbUrl, adminFetch, requireAdmin } from '../../_lib/admin.js';
import { errorResponse, json } from '../../_lib/http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(['pending', 'confirmed', 'scheduled', 'in_transit', 'completed', 'cancelled', 'declined']);

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const path = adminDbUrl(env, 'bookings', '?select=id,reference_code,status,quote_status,quoted_total_php,quote_note,quote_offered_at,customer_name,customer_phone,pickup_address,dropoff_address,pet_type,breed,age,weight_kg,cage_option,total_php,created_at,trip:trips(origin,destination,departure_at)&order=created_at.desc&limit=200');
  const result = await adminFetch(env, path);
  if (!result.ok) return errorResponse('Could not load bookings.', 502);
  return json({ bookings: await result.json() });
}

export async function onRequestPatch({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const id = new URL(request.url).searchParams.get('id');
  const input = await adminBody(request, 1000);
  if (!UUID.test(id || '') || !input) return errorResponse('Choose a valid booking and update.', 400);
  if (Object.hasOwn(input, 'quoted_total_php')) {
    const amount = Number(input.quoted_total_php);
    const note = typeof input.quote_note === 'string' ? input.quote_note.trim() : '';
    if (!Number.isInteger(amount) || amount < 0 || amount > 1000000 || note.length > 500) {
      return errorResponse('Enter a valid quote from ₱0 to ₱1,000,000 and a note under 500 characters.', 400);
    }
    const result = await adminFetch(env, adminDbUrl(env, 'bookings', `?id=eq.${id}&status=eq.pending&quote_status=neq.accepted`), {
      method: 'PATCH', headers: { prefer: 'return=representation' },
      body: JSON.stringify({ quoted_total_php: amount, quote_status: 'offered', quote_note: note, quote_offered_at: new Date().toISOString(), quote_responded_at: null }),
    });
    if (!result.ok) return errorResponse('Could not save this quote.', 502);
    const rows = await result.json();
    if (!rows.length) return errorResponse('This booking is no longer waiting for a quote, or the customer has already accepted it.', 409);
    return json({ booking: rows[0] });
  }
  if (!STATES.has(input.status)) return errorResponse('Choose a valid booking status.', 400);
  const current = await adminFetch(env, adminDbUrl(env, 'bookings', `?id=eq.${id}&select=status,quote_status&limit=1`));
  if (!current.ok) return errorResponse('Could not load this booking.', 502);
  const [booking] = await current.json();
  if (!booking) return errorResponse('Booking not found.', 404);
  if (input.status === 'confirmed' && booking.quote_status !== 'accepted') {
    return errorResponse('The customer must accept the owner quote before this booking can be confirmed.', 409);
  }
  if (booking.quote_status !== 'accepted' && !['pending', 'declined'].includes(input.status)) {
    return errorResponse('The booking must remain pending until the customer accepts the owner quote.', 409);
  }
  if (booking.quote_status === 'accepted' && input.status === 'pending') {
    return errorResponse('A customer-accepted booking cannot return to pending.', 409);
  }
  const update = { status: input.status };
  if (input.status === 'declined' && booking.quote_status === 'offered') {
    update.quote_status = 'declined';
    update.quote_responded_at = new Date().toISOString();
  }
  const result = await adminFetch(env, adminDbUrl(env, 'bookings', `?id=eq.${id}&status=eq.${booking.status}&quote_status=eq.${booking.quote_status}`), {
    method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(update),
  });
  if (!result.ok) return errorResponse('Could not update this booking.', 502);
  const rows = await result.json();
  if (!rows.length) return errorResponse('The booking changed while you were updating it. Refresh the owner portal and try again.', 409);
  return json({ booking: rows[0] });
}
