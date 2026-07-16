# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**. WHOOP is an optional add-on.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

The dashboard opens to a **password screen** — the default password is in
[`lock.js`](lock.js) (`var PASSWORD = "qwer"`). Change it to whatever you want.

---

## 2. Supabase (cross-device sync) — required for sync

Create a free project at **supabase.com**, then run **both** SQL blocks in
**SQL Editor → New query → Run**.

### SQL #1 — `app_state` (all dashboard sync)
```sql
create table if not exists public.app_state (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The browser uses the ANON key, so allow it to read/write:
alter table public.app_state enable row level security;
create policy "anon full access app_state"
  on public.app_state for all
  to anon using (true) with check (true);

-- Instant cross-device updates:
alter publication supabase_realtime add table public.app_state;
```

### SQL #2 — progress-photo sync (Storage bucket)
Progress photos upload to a Supabase **Storage** bucket called `progress-photos` (only the
image URLs sync through `app_state`). Skip this if you don't need photos to sync across devices.
```sql
insert into storage.buckets (id, name, public)
values ('progress-photos', 'progress-photos', true)
on conflict (id) do nothing;

create policy "anon manage progress-photos"
  on storage.objects for all
  to anon
  using (bucket_id = 'progress-photos')
  with check (bucket_id = 'progress-photos');
```

### Connect YOUR Supabase — pick ONE way
Supabase → **Project Settings → API**. Copy the **Project URL** and the **anon / publishable** key.

**Way A — Vercel env vars (easiest, no code edits):**
In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |

Redeploy. The app reads these automatically via `/api/config`.

**Way B — edit the files:**
Replace the old URL/key in these files:
- [`sync.js`](sync.js)
- [`topbar.js`](topbar.js)
- [`gym.html`](gym.html)

> ⚠️ Only the **anon** key (public) is used here. **Never** put the `service_role` key in code
> or in these env vars.

---

## 3. WHOOP (optional)

1. **developer.whoop.com** → create an app.
2. Set its **Redirect URI** to exactly: `https://your-app.vercel.app/api/whoop-callback`
   (use your real Vercel domain — add every domain you'll open the site from).
3. Put your app's **Client ID** in [`health.html`](health.html) (`const CLIENT_ID = '...'`),
   and add these in Vercel → **Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `WHOOP_CLIENT_ID` | your WHOOP app's Client ID |
| `WHOOP_CLIENT_SECRET` | your WHOOP app's Client Secret (**secret**) |

4. Open the site at that exact domain → Health page → **Connect WHOOP**.

> The callback auto-detects the domain, so you do **not** need a `WHOOP_REDIRECT_URI` env var.

---

## 4. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com.

---

## 5. Text reminders (optional)

`main.html`'s "Recurring Items" list (Gym, Water, Read, etc.) can text you a digest of
whatever's still undone, a couple times a day. This runs entirely server-side on a schedule —
it doesn't need the dashboard open in a browser. It reuses your existing Supabase
`SUPABASE_URL`/`SUPABASE_ANON_KEY` from step 2, so nothing extra needed there. Pick **one** of
the two delivery methods below (Twilio is preferred automatically if both happen to be set).

**Option A — free, via your carrier's email-to-SMS gateway (recommended to start):**

Every US carrier lets you "text" a phone by emailing a special address. A free service called
**Resend** sends that email on a schedule — no phone number to buy, no card required.

1. **resend.com** → sign up (email/password or GitHub, no card needed for the free tier) →
   **API Keys** → create one → copy it.
2. Find your phone's gateway address — `<your 10-digit number>@<carrier domain>`:

| Carrier | Domain |
|---|---|
| Verizon | `vtext.com` |
| T-Mobile | `tmomail.net` |
| AT&T | `txt.att.net` |
| Google Fi | `msg.fi.google.com` |
| Cricket | `sms.cricketwireless.net` |
| Boost Mobile | `sms.myboostmobile.com` |
| Metro by T-Mobile | `mymetropcs.com` |
| US Cellular | `email.uscc.net` |
| Visible | `vtext.com` |

   e.g. Verizon number `5551234567` → `5551234567@vtext.com`

3. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | from resend.com |
| `SMS_GATEWAY_TO` | your gateway address from step 2, e.g. `5551234567@vtext.com` |
| `REMINDER_TIMEZONE` | your IANA timezone, e.g. `America/New_York` (default if unset) |
| `REMINDER_HOURS_LOCAL` | comma-separated 24h hours to check, e.g. `14,20` (default if unset) |
| `CRON_SECRET` | any random string — **strongly recommended**, see below |

> Carrier gateways aren't as instant or reliable as real SMS — texts can occasionally arrive
> late or not at all. If that becomes annoying, Option B below is the fix.

**Option B — paid, via Twilio (more reliable):**

1. **twilio.com** → sign up → buy a phone number (~$1/mo; texts cost fractions of a cent each).
   From the Console **Dashboard**, copy your **Account SID** and **Auth Token**.
2. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | from the Twilio console (**secret**) |
| `TWILIO_FROM_NUMBER` | the Twilio number you bought, e.g. `+15551234567` |
| `TWILIO_TO_NUMBER` | your real phone, e.g. `+15559876543` |
| `REMINDER_TIMEZONE` / `REMINDER_HOURS_LOCAL` / `CRON_SECRET` | same as Option A above |

**Either way:**

3. Redeploy after adding the env vars above.
4. Scheduling runs on **GitHub Actions**, not Vercel Cron — see
   [`.github/workflows/reminders.yml`](.github/workflows/reminders.yml). Vercel's free Hobby
   plan only allows cron schedules that fire once a day each, which can't do hourly; a scheduled
   GitHub Actions workflow on a public repo is free at any frequency, so that's what pings
   `/api/send-reminders` instead ([`vercel.json`](vercel.json) is intentionally empty). To turn
   it on:
   - Repo → **Settings → Secrets and variables → Actions → New repository secret** → name it
     `CRON_SECRET`, value = the **same** random string you set as the `CRON_SECRET` env var in
     Vercel (step 3 above). This is what lets the workflow call your endpoint without exposing
     it publicly.
   - That's it — the workflow is already scheduled hourly (8am-10pm America/New_York during
     EDT). It'll start firing on the next scheduled hour, or trigger it immediately yourself:
     repo → **Actions** tab → **Hourly dashboard reminders** → **Run workflow**.
   - The function itself is still the actual gate on *how often you get texted* — it only sends
     if the current local hour is listed in `REMINDER_HOURS_LOCAL` and something's undone, so
     set that env var to every hour you want covered, e.g.
     `8,9,10,11,12,13,14,15,16,17,18,19,20,21,22` for hourly 8am-10pm — narrower than that (say,
     just `14,20`) and the workflow keeps pinging every hour but only actually texts you twice.

   > **Twice a year**, around DST changes (mid-March, early November), the workflow's fixed UTC
   > cron times land an hour off from `REMINDER_HOURS_LOCAL` for about a week until manually
   > nudged — texts just quietly pause for a few days rather than arrive at the wrong time. If
   > that happens, edit the `cron:` line in `.github/workflows/reminders.yml` by ±1 hour (or
   > shift `REMINDER_HOURS_LOCAL` to match whichever local hour it's currently landing on).
5. Add whichever recurring items you want texted about via the **Recurring Items** panel on
   the Main tab — anything with no `CRON_SECRET` set is reachable by anyone who finds the
   URL, who could then spam your phone or burn through your quota, so set it.

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`,
   `topbar.js`, `gym.html`.
3. (Optional) WHOOP: Client ID in `health.html` + the two env vars in Vercel.
4. (Optional) Text reminders: Resend (free) or Twilio (paid) + the env vars in step 5 above.
5. Change the password in `lock.js`. Done.
