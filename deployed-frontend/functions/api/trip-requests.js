import { errorResponse, json, text } from '../_lib/http.js';
import { serviceRequest } from '../_lib/supabase.js';

const MAX_BODY_BYTES = 12_000;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const tripRequest = {
    reference_code: `WOP-R-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
    origin: text(input.origin, 120),
    destination: text(input.destination, 120),
    via: text(input.via || '', 250),
    preferred_date: text(input.preferred_date, 10),
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
  const date = new Date(`${tripRequest.preferred_date}T00:00:00Z`);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(tripRequest.preferred_date)
    && Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === tripRequest.preferred_date;
  const todayInManila = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  if (!tripRequest.origin || !tripRequest.destination || tripRequest.origin === tripRequest.destination) return null;
  if (!validDate || tripRequest.preferred_date < todayInManila) return null;
  if (tripRequest.customer_name.length < 2 || tripRequest.customer_phone.length < 5) return null;
  if (!tripRequest.pickup_address || !tripRequest.dropoff_address || !tripRequest.pet_type || !tripRequest.breed || !tripRequest.age) return null;
  if (!Number.isFinite(tripRequest.weight_kg) || tripRequest.weight_kg <= 0 || tripRequest.weight_kg >= 500) return null;
  if (!['own', 'rent'].includes(tripRequest.cage_option) || !tripRequest.health_confirmed || !tripRequest.terms_confirmed) return null;
  return tripRequest;
}

async function notifyOwner(env, request) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.OWNER_NOTIFICATION_EMAIL) return 'not_configured';
  const route = `${request.origin} to ${request.destination}${request.via ? ` via ${request.via}` : ''}`;
  const lines = [
    `Request: ${request.reference_code}`,
    `Customer: ${request.customer_name}`,
    `Phone: ${request.customer_phone}`,
    `Requested route: ${route}`,
    `Preferred date: ${request.preferred_date}`,
    `Pet: ${request.pet_type} · ${request.breed} · ${request.age} · ${request.weight_kg} kg`,
    `Cage: ${request.cage_option === 'rent' ? 'Rental requested' : 'Customer has a cage'}`,
    `Pickup: ${request.pickup_address}`,
    `Drop-off: ${request.dropoff_address}`,
    'Status: Pending owner review. No trip or capacity has been reserved.',
  ];
  const html = `<h2>New custom trip request</h2><p><b>${escapeHtml(request.reference_code)}</b></p><dl>${lines.slice(1).map((line) => `<dd>${escapeHtml(line)}</dd>`).join('')}</dl>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [env.OWNER_NOTIFICATION_EMAIL],
      subject: `Custom pet trip request · ${request.reference_code}`,
      text: lines.join('\n'),
      html,
    }),
  });
  return response.ok ? 'sent' : 'failed';
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return errorResponse('Trip request service is not configured yet.', 503);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) return errorResponse('Trip request is too large.', 413);
  if (!request.headers.get('content-type')?.includes('application/json')) return errorResponse('Send a JSON trip request.', 415);

  let input;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return errorResponse('Trip request is too large.', 413);
    input = JSON.parse(raw);
  } catch {
    return errorResponse('Trip request details are not valid JSON.', 400);
  }
  const tripRequest = validateRequest(input);
  if (!tripRequest) return errorResponse('Check the required route, date, pet details, contact details, and consent boxes.', 400);

  const response = await serviceRequest(env, '/rest/v1/trip_requests', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(tripRequest),
  });
  if (!response.ok) {
    console.error('Could not save custom trip request:', response.status);
    return errorResponse('Could not save your request. Please try again or contact World of Pets.', 502);
  }
  const [created] = await response.json();
  if (!created?.id || !created?.reference_code) return errorResponse('Trip request was saved, but its confirmation could not be loaded.', 502);

  let notification = 'not_configured';
  try {
    notification = await notifyOwner(env, created);
  } catch (error) {
    console.error('Custom trip request email failed:', error.message);
    notification = 'failed';
  }
  return json({ request: { reference_code: created.reference_code, status: created.status }, notification }, 201);
}
