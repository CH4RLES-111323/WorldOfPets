import { errorResponse, json, text } from '../_lib/http.js';
import { callRpc, supabaseUrl, supabaseHeaders } from '../_lib/supabase.js';

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_PUBLISHABLE_KEY) return errorResponse('Booking tracking is not configured yet.', 503);
  const params = new URL(request.url).searchParams;
  const reference = text(params.get('reference'), 24).toUpperCase();
  const phone = text(params.get('phone'), 40);
  if (!/^WOP-[A-F0-9]{12}$/.test(reference) || phone.replace(/\D/g, '').length < 7) {
    return errorResponse('Enter the booking reference and phone number used for the booking.', 400);
  }

  try {
    const result = await callRpc(env, env.SUPABASE_PUBLISHABLE_KEY, 'get_public_booking_status', {
      p_reference: reference,
      p_phone: phone,
    });
    const booking = Array.isArray(result) ? result[0] : result;
    if (!booking) return errorResponse('No booking matched those details.', 404);
    return json({ booking });
  } catch (error) {
    console.error('Could not look up booking:', error.status || error.message);
    return errorResponse('Could not check booking status right now.', 502);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_PUBLISHABLE_KEY) return errorResponse('Booking updates are not configured yet.', 503);
  if (!request.headers.get('content-type')?.includes('application/json')) return errorResponse('Send a JSON booking response.', 415);
  let input;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2000) return errorResponse('Booking response is too large.', 413);
    input = JSON.parse(raw);
  } catch {
    return errorResponse('Booking response is not valid JSON.', 400);
  }
  const reference = text(input?.reference, 24).toUpperCase();
  const phone = text(input?.phone, 40);
  if (!/^WOP-[A-F0-9]{12}$/.test(reference) || phone.replace(/\D/g, '').length < 7 || !['accept', 'decline'].includes(input?.decision)) {
    return errorResponse('Enter the booking reference, booking phone, and choose accept or decline.', 400);
  }
  try {
    const response = await fetch(supabaseUrl(env, '/rest/v1/rpc/respond_to_booking_quote'), {
      method: 'POST',
      headers: supabaseHeaders(env.SUPABASE_PUBLISHABLE_KEY),
      body: JSON.stringify({ p_reference: reference, p_phone: phone, p_accept: input.decision === 'accept' }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      if (result?.code === 'P0002') return errorResponse('No booking matched those details.', 404);
      if (result?.message === 'QUOTE_NOT_AVAILABLE') return errorResponse('This booking has no open quote to respond to.', 409);
      console.error('Could not save customer quote response:', response.status);
      return errorResponse('Could not update the booking. Please try again.', 502);
    }
    const booking = Array.isArray(result) ? result[0] : result;
    return json({ booking });
  } catch (error) {
    console.error('Could not save customer quote response:', error.message);
    return errorResponse('Could not update the booking. Please try again.', 502);
  }
}
