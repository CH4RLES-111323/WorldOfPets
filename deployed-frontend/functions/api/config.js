import { errorResponse, json } from '../_lib/http.js';

export async function onRequestGet({ env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return errorResponse('Owner portal is not configured yet.', 503);
  return json({ supabaseUrl: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY });
}
