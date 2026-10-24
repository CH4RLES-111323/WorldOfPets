-- Customer requests for routes/dates that are not on the public schedule.
-- These records do not reserve capacity or create a trip.

create type public.trip_request_state as enum ('pending', 'accepted', 'declined');

create table public.trip_requests (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  reference_code text not null unique,
  status public.trip_request_state not null default 'pending',
  origin text not null check (length(trim(origin)) between 1 and 120),
  destination text not null check (length(trim(destination)) between 1 and 120),
  via text not null default '',
  preferred_date date not null,
  customer_name text not null check (length(trim(customer_name)) between 2 and 120),
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index trip_requests_created_at_idx on public.trip_requests (created_at desc);
create index trip_requests_status_created_idx on public.trip_requests (status, created_at desc);

create trigger trip_requests_set_updated_at
before update on public.trip_requests
for each row execute function public.set_updated_at();

alter table public.trip_requests enable row level security;
revoke all on public.trip_requests from public, anon, authenticated;
grant all on public.trip_requests to service_role;
grant select, insert, update, delete on public.trip_requests to authenticated;

create policy "Admins manage trip requests"
  on public.trip_requests for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
