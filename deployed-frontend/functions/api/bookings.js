import { errorResponse, json, text } from '../_lib/http.js';
import { callRpc, serviceRequest } from '../_lib/supabase.js';

const MAX_BODY_BYTES = 12_000;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function validateBooking(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const booking = {
    trip_id: text(input.trip_id, 36),
    customer_name: text(input.customer_name, 120),
    customer_phone: text(input.customer_phone, 40),
    pickup_address: text(input.pickup_address, 500),
    dropoff_address: text(input.dropoff_address, 500),
    pet_type: text(input.pet_type, 60),
    breed: text(input.breed, 120),
    age: text(input.age, 40),
    weight_kg: Number(input.weight_kg),
    cage_option: input.cage_option,
    health_confirmed: input.health_confirmed === true,
    terms_confirmed: input.terms_confirmed === true,
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(booking.trip_id)) return null;
  if (!booking.customer_name || booking.customer_name.length < 2 || !booking.customer_phone) return null;
  if (!booking.pickup_address || !booking.dropoff_address || !booking.pet_type || !booking.breed || !booking.age) return null;
  if (!Number.isFinite(booking.weight_kg) || booking.weight_kg <= 0 || booking.weight_kg >= 500) return null;
  if (!['own', 'rent'].includes(booking.cage_option) || !booking.health_confirmed || !booking.terms_confirmed) return null;
  return booking;
}

async function sendOwnerEmail(env, bookingId) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.OWNER_NOTIFICATION_EMAIL) {
    return { sent: false, reason: 'email_not_configured' };
  }

  const path = `/rest/v1/bookings?id=eq.${encodeURIComponent(bookingId)}&select=reference_code,customer_name,customer_phone,pickup_address,dropoff_address,pet_type,breed,age,weight_kg,cage_option,total_php,created_at,trip:trips(origin,destination,via,departure_at)`;
  const response = await serviceRequest(env, path);
  if (!response.ok) throw new Error('Could not load booking details for notification.');
  const rows = await response.json();
  const booking = rows?.[0];
  if (!booking) throw new Error('Booking details were not found.');
  const trip = booking.trip;
  const subject = `New pet transport request · ${booking.reference_code}`;
  const lines = [
    `Booking: ${booking.reference_code}`,
    `Customer: ${booking.customer_name}`,
    `Phone: ${booking.customer_phone}`,
    `Pet: ${booking.pet_type} · ${booking.breed} · ${booking.age} · ${booking.weight_kg} kg`,
    `Cage: ${booking.cage_option === 'rent' ? 'Rental' : 'Customer provides'}`,
    `Trip: ${trip.origin} to ${trip.destination}${trip.via ? ` via ${trip.via}` : ''}`,
    `Departure: ${new Date(trip.departure_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`,
    `Pickup: ${booking.pickup_address}`,
    `Drop-off: ${booking.dropoff_address}`,
    'Status: Pending owner price quote. The customer must review and accept the quote before confirmation.',
    `Existing schedule fare for reference only: PHP ${booking.total_php.toLocaleString('en-PH')}`,
  ];
  const html = `<h2>New pet transport request</h2><p><b>${escapeHtml(booking.reference_code)}</b></p><dl>${lines.slice(1).map((line) => `<dd>${escapeHtml(line)}</dd>`).join('')}</dl>`;
  const sent = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [env.OWNER_NOTIFICATION_EMAIL], subject, text: lines.join('\n'), html }),
  });
  if (!sent.ok) throw new Error(`Email provider returned ${sent.status}.`);
  return { sent: true };
}

async function updateOutbox(env, bookingId, state, errorMessage = null) {
  const url = `/rest/v1/notification_outbox?booking_id=eq.${encodeURIComponent(bookingId)}&event_type=eq.booking.created`;
  const response = await serviceRequest(env, url, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      state,
      attempts: state === 'pending' ? 0 : 1,
      last_error: errorMessage,
      sent_at: state === 'sent' ? new Date().toISOString() : null,
    }),
  });
  if (!response.ok) console.error('Could not update notification outbox state:', response.status);
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return errorResponse('Booking service is not configured yet.', 503);
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) return errorResponse('Booking request is too large.', 413);
  if (!request.headers.get('content-type')?.includes('application/json')) return errorResponse('Send a JSON booking request.', 415);

  let input;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return errorResponse('Booking request is too large.', 413);
    input = JSON.parse(raw);
  } catch {
    return errorResponse('Booking details are not valid JSON.', 400);
  }
  const booking = validateBooking(input);
  if (!booking) return errorResponse('Check the required booking details and consent boxes.', 400);

  let created;
  try {
    const result = await callRpc(env, env.SUPABASE_PUBLISHABLE_KEY, 'create_public_booking', { p_booking: booking });
    created = Array.isArray(result) ? result[0] : result;
    if (!created?.id || !created?.reference_code) throw new Error('Booking service returned an invalid response.');
  } catch (error) {
    if (error.code === 'TRIP_FULL' || error.code === 'TRIP_UNAVAILABLE') return errorResponse('That trip no longer has an available slot. Refresh the calendar and choose another trip.', 409);
    if (error.status === 400 || error.status === 404) return errorResponse('The selected trip could not be booked.', 409);
    console.error('Could not create booking:', error.status || error.message);
    return errorResponse('Could not save your booking. Please try again or contact World of Pets.', 502);
  }

  let email = { sent: false, reason: 'email_pending' };
  try {
    email = await sendOwnerEmail(env, created.id);
  } catch (error) {
    console.error('Owner booking email failed:', error.message);
  }
  const outboxState = email.sent ? 'sent' : email.reason === 'email_not_configured' ? 'pending' : 'failed';
  await updateOutbox(env, created.id, outboxState, email.reason || null);

  return json({ booking: { id: created.id, reference_code: created.reference_code, status: created.status }, notification: outboxState === 'sent' ? 'sent' : 'pending' }, 201);
}
