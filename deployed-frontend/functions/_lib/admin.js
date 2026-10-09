import { errorResponse } from './http.js';
import { serviceRequest, supabaseUrl } from './supabase.js';

export async function requireAdmin(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { response: errorResponse('Sign in with an authorized owner account.', 401) };
  }

  try {
    const auth = await fetch(supabaseUrl(env, '/auth/v1/user'), {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${token}` },
    });
    if (!auth.ok) return { response: errorResponse('Your session has expired. Please sign in again.', 401) };
    const user = await auth.json();
    const membership = await serviceRequest(
      env,
      `/rest/v1/admin_users?user_id=eq.${encodeURIComponent(user.id)}&select=user_id&limit=1`,
    );
    if (!membership.ok) throw new Error('Could not verify owner permissions.');
    if (!(await membership.json()).length) return { response: errorResponse('This account is not authorized to manage World of Pets.', 403) };
    return { user };
  } catch (error) {
    if (error.status) return { response: errorResponse('Could not verify your owner session.', 502) };
    console.error('Owner authentication failed:', error.message);
    return { response: errorResponse('Could not verify your owner session.', 502) };
  }
}

export async function adminBody(request, limit = 12000) {
  if (!request.headers.get('content-type')?.includes('application/json')) return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > limit) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function adminDbUrl(env, table, query = '') {
  return supabaseUrl(env, `/rest/v1/${table}${query}`);
}

export function adminFetch(env, url, options = {}) {
  return serviceRequest(env, url.replace(/^https?:\/\/[^/]+/, ''), options);
}
