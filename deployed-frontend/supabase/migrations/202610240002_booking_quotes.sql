-- Owners manually quote each booking. A booking remains pending until the
-- customer accepts the offered quote using their reference code and phone.

create type public.booking_quote_state as enum ('not_quoted', 'offered', 'accepted', 'declined');

alter table public.bookings
  add column quote_status public.booking_quote_state not null default 'not_quoted',
  add column quoted_total_php integer check (quoted_total_php is null or quoted_total_php between 0 and 1000000),
  add column quote_note text not null default '' check (length(quote_note) <= 500),
  add column quote_offered_at timestamptz,
  add column quote_responded_at timestamptz;

drop function public.get_public_booking_status(text, text);
create function public.get_public_booking_status(p_reference text, p_phone text)
returns table (
  reference_code text,
  status text,
  origin text,
  destination text,
  departure_at timestamptz,
  pet_type text,
  quote_status text,
  quoted_total_php integer,
  quote_note text,
  quote_offered_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.reference_code, b.status::text, t.origin, t.destination, t.departure_at,
    b.pet_type, b.quote_status::text, b.quoted_total_php, b.quote_note, b.quote_offered_at
  from public.bookings b
  join public.trips t on t.id = b.trip_id
  where b.reference_code = upper(trim(p_reference))
    and pg_catalog.regexp_replace(b.customer_phone, '[^0-9]', '', 'g')
      = pg_catalog.regexp_replace(p_phone, '[^0-9]', '', 'g')
  limit 1;
$$;

create function public.respond_to_booking_quote(p_reference text, p_phone text, p_accept boolean)
returns table (
  reference_code text,
  status text,
  origin text,
  destination text,
  departure_at timestamptz,
  pet_type text,
  quote_status text,
  quoted_total_php integer,
  quote_note text,
  quote_offered_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
begin
  select b.* into v_booking
  from public.bookings b
  where b.reference_code = upper(trim(p_reference))
    and pg_catalog.regexp_replace(b.customer_phone, '[^0-9]', '', 'g')
      = pg_catalog.regexp_replace(p_phone, '[^0-9]', '', 'g')
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'BOOKING_NOT_FOUND';
  end if;
  if v_booking.status <> 'pending' or v_booking.quote_status <> 'offered' then
    raise exception using errcode = 'P0001', message = 'QUOTE_NOT_AVAILABLE';
  end if;

  update public.bookings b
  set quote_status = case when p_accept then 'accepted'::public.booking_quote_state else 'declined'::public.booking_quote_state end,
      status = case when p_accept then 'confirmed'::public.booking_state else 'declined'::public.booking_state end,
      quote_responded_at = pg_catalog.now()
  where b.id = v_booking.id;

  return query
  select b.reference_code, b.status::text, t.origin, t.destination, t.departure_at,
    b.pet_type, b.quote_status::text, b.quoted_total_php, b.quote_note, b.quote_offered_at
  from public.bookings b
  join public.trips t on t.id = b.trip_id
  where b.id = v_booking.id;
end;
$$;

revoke all on function public.get_public_booking_status(text, text) from public, authenticated;
grant execute on function public.get_public_booking_status(text, text) to anon, authenticated;
revoke all on function public.respond_to_booking_quote(text, text, boolean) from public, authenticated;
grant execute on function public.respond_to_booking_quote(text, text, boolean) to anon, authenticated;
