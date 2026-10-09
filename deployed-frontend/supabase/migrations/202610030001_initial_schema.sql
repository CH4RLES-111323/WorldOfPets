-- World of Pets booking and owner scheduling foundation.
-- Run this migration in the Supabase SQL editor or with the Supabase CLI.

create type public.trip_state as enum ('open', 'closed', 'cancelled', 'completed');
create type public.booking_state as enum (
  'pending', 'confirmed', 'scheduled', 'in_transit', 'completed', 'cancelled', 'declined'
);
create type public.notification_state as enum ('pending', 'sent', 'failed');

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.trips (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  origin text not null check (length(trim(origin)) between 1 and 120),
  destination text not null check (length(trim(destination)) between 1 and 120),
  via text not null default '',
  departure_at timestamptz not null,
  fare_php integer not null check (fare_php >= 0),
  capacity smallint not null check (capacity between 1 and 100),
  state public.trip_state not null default 'open',
  is_public boolean not null default true,
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bookings (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  reference_code text not null unique,
  trip_id uuid not null references public.trips(id) on delete restrict,
  status public.booking_state not null default 'pending',
  customer_name text not null check (length(trim(customer_name)) between 1 and 120),
  customer_phone text not null check (length(trim(customer_phone)) between 5 and 40),
  pickup_address text not null check (length(trim(pickup_address)) between 1 and 500),
  dropoff_address text not null check (length(trim(dropoff_address)) between 1 and 500),
  pet_type text not null check (length(trim(pet_type)) between 1 and 60),
  breed text not null check (length(trim(breed)) between 1 and 120),
  age text not null check (length(trim(age)) between 1 and 40),
  weight_kg numeric(6,2) not null check (weight_kg > 0 and weight_kg < 500),
  cage_option text not null check (cage_option in ('own', 'rent')),
  health_confirmed boolean not null check (health_confirmed),
  terms_confirmed boolean not null check (terms_confirmed),
  total_php integer not null check (total_php >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.notification_outbox (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  event_type text not null check (event_type in ('booking.created')),
  state public.notification_state not null default 'pending',
  attempts smallint not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (booking_id, event_type)
);

create index trips_public_departure_idx
  on public.trips (departure_at)
  where is_public and state = 'open';
create index bookings_trip_active_idx
  on public.bookings (trip_id, status)
  where status in ('pending', 'confirmed', 'scheduled', 'in_transit');
create index bookings_created_at_idx on public.bookings (created_at desc);
create index notification_outbox_pending_idx
  on public.notification_outbox (created_at)
  where state in ('pending', 'failed');

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trips_set_updated_at
before update on public.trips
for each row execute function public.set_updated_at();

create trigger bookings_set_updated_at
before update on public.bookings
for each row execute function public.set_updated_at();

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users a
    where a.user_id = (select auth.uid())
  );
$$;

-- The public calendar can read trip details and remaining capacity, but never
-- customer or booking records. The date range is supplied by the caller.
create function public.get_public_trips(p_from timestamptz, p_until timestamptz)
returns table (
  id uuid,
  origin text,
  destination text,
  via text,
  trip_date date,
  departure_at timestamptz,
  fare_php integer,
  capacity integer,
  booked integer,
  available integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id,
    t.origin,
    t.destination,
    t.via,
    (t.departure_at at time zone 'Asia/Manila')::date as trip_date,
    t.departure_at,
    t.fare_php,
    t.capacity::integer,
    count(b.id)::integer as booked,
    greatest(t.capacity::integer - count(b.id)::integer, 0) as available
  from public.trips t
  left join public.bookings b
    on b.trip_id = t.id
   and b.status in ('pending', 'confirmed', 'scheduled', 'in_transit')
  where t.is_public
    and t.state = 'open'
    and t.departure_at >= greatest(p_from, now())
    and t.departure_at < p_until
  group by t.id
  order by t.departure_at;
$$;

-- Tracking requires both the booking reference and the customer's phone.
-- Only non-sensitive progress fields are returned to the public caller.
create function public.get_public_booking_status(p_reference text, p_phone text)
returns table (
  reference_code text,
  status text,
  origin text,
  destination text,
  departure_at timestamptz,
  pet_type text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.reference_code, b.status::text, t.origin, t.destination, t.departure_at, b.pet_type
  from public.bookings b
  join public.trips t on t.id = b.trip_id
  where b.reference_code = upper(trim(p_reference))
    and pg_catalog.regexp_replace(b.customer_phone, '[^0-9]', '', 'g')
      = pg_catalog.regexp_replace(p_phone, '[^0-9]', '', 'g')
  limit 1;
$$;

-- Booking creation and capacity reservation happen in one transaction. Locking
-- the selected trip serializes simultaneous requests for its final open slot.
create function public.create_public_booking(p_booking jsonb)
returns table (id uuid, reference_code text, status public.booking_state)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_booked integer;
  v_id uuid := pg_catalog.gen_random_uuid();
  v_reference text;
  v_cage text := p_booking ->> 'cage_option';
  v_fare integer;
begin
  select * into v_trip
  from public.trips
  where trips.id = (p_booking ->> 'trip_id')::uuid
  for update;

  if not found or v_trip.state <> 'open' or not v_trip.is_public or v_trip.departure_at <= now() then
    raise exception using errcode = 'P0001', message = 'TRIP_UNAVAILABLE';
  end if;

  select count(*)::integer into v_booked
  from public.bookings
  where bookings.trip_id = v_trip.id
    and bookings.status in ('pending', 'confirmed', 'scheduled', 'in_transit');

  if v_booked >= v_trip.capacity then
    raise exception using errcode = 'P0001', message = 'TRIP_FULL';
  end if;

  if v_cage not in ('own', 'rent')
     or p_booking ->> 'health_confirmed' <> 'true'
     or p_booking ->> 'terms_confirmed' <> 'true' then
    raise exception using errcode = '22023', message = 'INVALID_BOOKING';
  end if;

  v_fare := v_trip.fare_php + case when v_cage = 'rent' then 300 else 0 end;
  v_reference := 'WOP-' || upper(substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12));

  insert into public.bookings (
    id, reference_code, trip_id, customer_name, customer_phone,
    pickup_address, dropoff_address, pet_type, breed, age, weight_kg,
    cage_option, health_confirmed, terms_confirmed, total_php
  ) values (
    v_id, v_reference, v_trip.id,
    trim(p_booking ->> 'customer_name'), trim(p_booking ->> 'customer_phone'),
    trim(p_booking ->> 'pickup_address'), trim(p_booking ->> 'dropoff_address'),
    trim(p_booking ->> 'pet_type'), trim(p_booking ->> 'breed'), trim(p_booking ->> 'age'),
    (p_booking ->> 'weight_kg')::numeric, v_cage, true, true, v_fare
  );

  insert into public.notification_outbox (booking_id, event_type)
  values (v_id, 'booking.created');

  return query select v_id, v_reference, 'pending'::public.booking_state;
end;
$$;

alter table public.admin_users enable row level security;
alter table public.trips enable row level security;
alter table public.bookings enable row level security;
alter table public.notification_outbox enable row level security;

revoke all on public.admin_users, public.trips, public.bookings, public.notification_outbox from anon, authenticated;
grant all on public.admin_users, public.trips, public.bookings, public.notification_outbox to service_role;
grant usage, select on sequence public.notification_outbox_id_seq to service_role;
grant select, insert, update, delete on public.admin_users, public.trips, public.bookings to authenticated;
grant select on public.notification_outbox to authenticated;
grant all on public.notification_outbox to service_role;

create policy "Admins can read their own admin record"
  on public.admin_users for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Admins manage trips"
  on public.trips for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "Admins manage bookings"
  on public.bookings for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "Admins read notification status"
  on public.notification_outbox for select to authenticated
  using ((select public.is_admin()));

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke all on function public.get_public_trips(timestamptz, timestamptz) from public, authenticated;
grant execute on function public.get_public_trips(timestamptz, timestamptz) to anon, authenticated;

revoke all on function public.get_public_booking_status(text, text) from public, authenticated;
grant execute on function public.get_public_booking_status(text, text) to anon, authenticated;

revoke all on function public.create_public_booking(jsonb) from public, authenticated;
grant execute on function public.create_public_booking(jsonb) to anon, authenticated;

-- Add the owner's Supabase Auth UUID after creating the owner's account:
-- insert into public.admin_users (user_id) values ('OWNER_AUTH_USER_UUID');
