export function supabaseHeaders(key, bearer = null) {
  const headers = { apikey: key, 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return headers;
}

export function supabaseUrl(env, path) {
  if (!env.SUPABASE_URL) throw new Error('Supabase is not configured.');
  return `${env.SUPABASE_URL.replace(/\/$/, '')}${path}`;
}

export async function callRpc(env, key, functionName, body) {
  const response = await fetch(supabaseUrl(env, `/rest/v1/rpc/${functionName}`), {
    method: 'POST',
    headers: supabaseHeaders(key),
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.message || 'Database request failed.');
    error.code = result?.message;
    error.status = response.status;
    throw error;
  }
  return result;
}

export async function serviceRequest(env, path, options = {}) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase server key is not configured.');
  return fetch(supabaseUrl(env, path), {
    ...options,
    headers: {
      ...supabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SERVICE_ROLE_KEY),
      ...(options.headers || {}),
    },
  });
}
