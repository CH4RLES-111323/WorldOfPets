import { errorResponse, json, text } from '../_lib/http.js';
import { callRpc, serviceRequest, supabaseUrl, supabaseHeaders } from '../_lib/supabase.js';

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_PUBLISHABLE_KEY) return errorResponse('Booking tracking is not configured yet.', 503);
  const params = new URL(request.url).searchParams;
  const reference = text(params.get('reference'), 32).toUpperCase().trim();
  const phone = text(params.get('phone'), 40).trim();
  const cleanDigits = phone.replace(/\D/g, '');
  if (!/^WOP(-R)?-[A-F0-9]{12}$/.test(reference) || cleanDigits.length < 7) {
    return errorResponse('Enter the booking reference and phone number used for the booking.', 400);
  }

  try {
    const result = await callRpc(env, env.SUPABASE_PUBLISHABLE_KEY, 'get_public_booking_status', {
      p_reference: reference,
      p_phone: phone,
    });
    const booking = Array.isArray(result) ? result[0] : result;
    if (booking) return json({ booking });

    if (env.SUPABASE_SERVICE_ROLE_KEY) {
      const trRes = await serviceRequest(
        env,
        `/rest/v1/trip_requests?reference_code=eq.${encodeURIComponent(reference)}&select=reference_code,status,origin,destination,preferred_date,pet_type,breed,customer_phone&limit=1`
      );
      if (trRes.ok) {
        const rows = await trRes.json();
        if (rows.length > 0) {
          const tr = rows[0];
          const trPhoneDigits = (tr.customer_phone || '').replace(/\D/g, '');
          if (trPhoneDigits.slice(-7) === cleanDigits.slice(-7)) {
            return json({
              booking: {
                reference_code: tr.reference_code,
                status: tr.status === 'accepted' ? 'accepted (scheduling)' : tr.status === 'declined' ? 'declined' : 'pending review',
                origin: tr.origin,
                destination: tr.destination,
                departure_at: `${tr.preferred_date}T08:00:00+08:00`,
                pet_type: `${tr.pet_type} (${tr.breed})`,
                quote_status: 'custom_request',
                quoted_total_php: null,
                quote_note: tr.status === 'pending'
                  ? 'Your custom trip request is being reviewed by the owner. When scheduled, your price quote will appear here.'
                  : tr.status === 'accepted'
                  ? 'Your request was accepted. The owner is setting up the schedule and price quote now.'
                  : 'This custom trip request could not be accommodated.',
                quote_offered_at: null,
                is_custom_request: true,
              },
            });
          }
        }
      }
    }

    return errorResponse('No booking matched those details.', 404);
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
  const reference = text(input?.reference, 32).toUpperCase().trim();
  const phone = text(input?.phone, 40).trim();
  if (!/^WOP(-R)?-[A-F0-9]{12}$/.test(reference) || phone.replace(/\D/g, '').length < 7 || !['accept', 'decline'].includes(input?.decision)) {
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
