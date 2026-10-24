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

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.response) return auth.response;
  const input = await adminBody(request, 8000);
  if (!input || input.action !== 'convert') return errorResponse('Invalid action.', 400);

  const requestId = input.request_id;
  if (!UUID.test(requestId || '')) return errorResponse('Valid trip request ID is required.', 400);

  const reqRes = await adminFetch(env, adminDbUrl(env, 'trip_requests', `?id=eq.${requestId}&limit=1`));
  if (!reqRes.ok) return errorResponse('Could not fetch trip request.', 502);
  const reqRows = await reqRes.json();
  const reqRow = reqRows[0];
  if (!reqRow) return errorResponse('Trip request not found.', 404);

  const departure = new Date(input.departure_at || `${reqRow.preferred_date}T08:00:00+08:00`);
  if (!Number.isFinite(departure.getTime())) return errorResponse('Enter a valid departure date and time.', 400);
  const fare = Number(input.fare_php ?? 550);
  const capacity = Number(input.capacity ?? 5);
  const isPublic = input.is_public !== false;
  if (!Number.isInteger(fare) || fare < 0 || fare > 1000000 || !Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
    return errorResponse('Check fare and capacity.', 400);
  }

  const tripPayload = {
    origin: reqRow.origin,
    destination: reqRow.destination,
    via: reqRow.via || '',
    departure_at: departure.toISOString(),
    fare_php: fare,
    capacity: capacity,
    state: 'open',
    is_public: isPublic,
    notes: `Created from custom request ${reqRow.reference_code}`,
    created_by: auth.user.id,
  };

  const tripRes = await adminFetch(env, adminDbUrl(env, 'trips'), {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(tripPayload),
  });
  if (!tripRes.ok) {
    console.error('Trip insert failed:', await tripRes.text());
    return errorResponse('Could not create schedule from request.', 502);
  }
  const [createdTrip] = await tripRes.json();

  const quotePrice = input.quote_price !== undefined && input.quote_price !== '' && input.quote_price !== null ? Number(input.quote_price) : null;
  const quoteNote = typeof input.quote_note === 'string' ? input.quote_note.trim().slice(0, 500) : '';

  const bookingPayload = {
    trip_id: createdTrip.id,
    reference_code: reqRow.reference_code,
    status: 'pending',
    quote_status: quotePrice !== null ? 'offered' : 'not_quoted',
    quoted_total_php: quotePrice,
    quote_note: quoteNote,
    quote_offered_at: quotePrice !== null ? new Date().toISOString() : null,
    customer_name: reqRow.customer_name,
    customer_phone: reqRow.customer_phone,
    pickup_address: reqRow.pickup_address,
    dropoff_address: reqRow.dropoff_address,
    pet_type: reqRow.pet_type,
    breed: reqRow.breed,
    age: reqRow.age,
    weight_kg: Number(reqRow.weight_kg),
    cage_option: reqRow.cage_option,
    health_confirmed: true,
    terms_confirmed: true,
    total_php: fare + (reqRow.cage_option === 'rent' ? 300 : 0),
  };

  const bookingRes = await adminFetch(env, adminDbUrl(env, 'bookings'), {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(bookingPayload),
  });
  if (!bookingRes.ok) {
    console.error('Booking insert failed:', await bookingRes.text());
    return errorResponse('Trip created, but failed to create booking record for customer.', 502);
  }
  const [createdBooking] = await bookingRes.json();

  await adminFetch(env, adminDbUrl(env, 'trip_requests', `?id=eq.${reqRow.id}`), {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ status: 'accepted' }),
  });

  return json({ ok: true, trip: createdTrip, booking: createdBooking }, 201);
}
