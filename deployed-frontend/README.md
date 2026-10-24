# World of Pets

The site currently serves the existing single-page frontend from `index.html`. The booking and calendar APIs are Cloudflare Pages Functions backed by Supabase. The GitHub Pages deployment is static and cannot run these APIs; use a Cloudflare Pages project connected to this repository before expecting live schedules and bookings to work.

## Backend setup

1. Create a Supabase project and run `supabase/migrations/202610030001_initial_schema.sql` in its SQL Editor. For an existing project that already ran the initial migration, run `supabase/migrations/202610240001_trip_requests.sql` to enable customer requests for unscheduled routes.
2. Create the owner's account in Supabase Auth, then add that account's UUID to `public.admin_users` using the SQL comment at the end of the migration. This allowlist is required for the owner portal at `/admin.html`; signing in alone does not grant management access. Never expose the Supabase service role key in browser code.
3. Add the variables from `.dev.vars.example` to Cloudflare Pages project secrets/environment variables. Use a verified sender domain in Resend and the owner's notification email. Set the Supabase URL, publishable key, and server-only service role key.
4. Connect this repository to Cloudflare Pages. Use the repository root as the output directory and no build command for the current static frontend. Keep `functions/` at the repository root so Pages discovers the API routes.
5. Add real trips to `public.trips` with `state = 'open'`, `is_public = true`, a future departure time, fare, and capacity. The public calendar reads this table; it does not contain demo trips.

## API routes

- `GET /api/trips` returns public future trips and live capacity.
- `POST /api/bookings` validates and atomically reserves a slot, saves the booking, and immediately attempts to email the owner through Resend. Notification state is recorded in `notification_outbox`.
- `POST /api/trip-requests` saves a customer's preferred route/date and pet/contact details as a pending request. It does not create a trip or reserve capacity, and it attempts to email the owner through Resend.
- `GET /api/booking-status?reference=WOP-…&phone=…` returns limited tracking details after checking both the reference and phone number.
- `/admin.html` is the owner portal. It uses Supabase Auth, then protected `/api/admin/*` routes verify the account against `admin_users` before allowing schedule, booking, or trip-request changes. Accepting a custom trip request records the owner's review; the owner must still contact the customer and add a separate trip if agreed.
- `GET /api/config` shares only the public Supabase URL and publishable key with the browser; server-only keys remain in Cloudflare secrets.

Until Supabase and Cloudflare are configured and real trips are entered, the local static preview intentionally shows that the live calendar is unavailable; it does not fall back to fake schedules or browser-only bookings.

The owner portal can create and edit trips, toggle public visibility, and cancel schedules while retaining existing bookings. The public calendar refreshes every 30 seconds. The portal also lists booking details and lets the owner update booking status. A cancelled trip is removed from new public bookings, while any existing customer records remain available to the owner.
