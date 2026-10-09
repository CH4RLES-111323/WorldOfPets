import { json, errorResponse, isValidDate } from '../_lib/http.js';
import { callRpc } from '../_lib/supabase.js';

const DAY = 24 * 60 * 60 * 1000;

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_PUBLISHABLE_KEY) return errorResponse('Trip calendar is not configured yet.', 503);

  const params = new URL(request.url).searchParams;
  const from = params.get('from') || new Date().toISOString();
  const until = params.get('until') || new Date(Date.now() + 93 * DAY).toISOString();
  if (!isValidDate(from) || !isValidDate(until)) return errorResponse('Use valid ISO dates for from and until.', 400);

  const start = Date.parse(from);
  const end = Date.parse(until);
  if (end <= start || end - start > 94 * DAY) return errorResponse('Choose a date range of up to 93 days.', 400);

  try {
    const trips = await callRpc(env, env.SUPABASE_PUBLISHABLE_KEY, 'get_public_trips', {
      p_from: new Date(start).toISOString(),
      p_until: new Date(end).toISOString(),
    });
    return json({ trips });
  } catch (error) {
    console.error('Could not load public trips:', error.status || error.message);
    return errorResponse('Could not load the trip calendar.', 502);
  }
}
