import { errorResponse, json, text } from '../_lib/http.js';
import { callRpc } from '../_lib/supabase.js';

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
