export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function errorResponse(message, status) {
  return json({ error: message }, status);
}

export function isValidDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
