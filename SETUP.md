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

> **Recovery-adaptive gym suggestions:** with WHOOP connected, the Gym tab shows a heads-up banner
> on days your recovery score is in WHOOP's own "red zone" (below 33%) — a suggestion to trim
> volume/intensity, never an automatic change to your actual program. Without WHOOP connected, it
> falls back to last night's manually-logged Peak sleep quality (2/5 or below) as the signal
> instead — the same "poor sleep" threshold that already delays the Telegram gym reminder.

---

## 4. Apple Health (optional)

Apple doesn't have a public web API for HealthKit the way WHOOP does OAuth — there's no
"connect" flow a website can hook into, full stop. The workaround is an **iOS Shortcut**
that reads your Health data and pushes it here on a schedule.

1. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `APPLE_HEALTH_SECRET` | any long random string — this is your shared secret |
| `APPLE_HEALTH_TIMEZONE` | optional, IANA tz name, default `America/New_York` |

   Redeploy after adding it.

2. On your iPhone, open **Shortcuts** → **+** → build a new shortcut:
   - Add a **Get Health Sample** action (or several) for whichever metrics you want —
     Steps, Active Energy, Exercise Minutes, Stand Hours, Resting Heart Rate, Sleep
     Analysis, Weight. For each one, add **Calculate Statistics** (Sum for steps/energy/
     exercise/stand, Average or the latest value for HR/sleep/weight) to turn it into a
     single number.
   - Add a **Text** action and build JSON by hand, e.g.:
     ```
     {"steps": [Steps result], "activeEnergyKcal": [Energy result], "sleepHours": [Sleep result]}
     ```
     (only include the fields you actually wired up — all fields are optional)
   - Add **Get Contents of URL**:
     - URL: `https://your-app.vercel.app/api/apple-health-ingest`
     - Method: **POST**
     - Headers: `Authorization` → `Bearer <your APPLE_HEALTH_SECRET>`, `Content-Type` → `application/json`
     - Request Body: **JSON** → the Text action's output
3. Tap the shortcut once to test it, then check the **Health** page on the dashboard —
   a stat card should appear with whatever fields you sent.
4. Automate it: **Automation** tab → **+** → **Personal Automation** → **Time of Day**
   (pick a few times a day, e.g. morning/midday/night) → **Run Shortcut** → your shortcut
   → turn off "Ask Before Running" so it fires silently in the background.

> Each POST only needs to carry the fields that changed — a same-day resend merges into
> that day's record instead of overwriting it, so an evening run with just sleep data
> won't erase the steps a morning run already sent.

---

## 5. Google — Calendar / Gmail / Drive (optional)

One connection covers all three (today's Calendar events, unread Gmail, recent Drive files)
on the **Google** tile (Today hub). Same OAuth pattern as WHOOP above.

1. **console.cloud.google.com** → create a project (or use an existing one).
2. **APIs & Services → Library** → enable these three: **Google Calendar API**, **Gmail API**,
   **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → External → fill in the basics → add these
   scopes: `calendar.events`, `gmail.readonly`, `drive.metadata.readonly` → add **yourself**
   as a test user → save. Leave it in **Testing** status — publishing/verification isn't
   needed for personal use, but see the caveat below. (`calendar.events` rather than
   `calendar.readonly` — the Telegram assistant can create/reschedule/cancel real events, not
   just read them; see step 8 below.)
4. **APIs & Services → Credentials** → **Create Credentials → OAuth client ID** → type
   **Web application** → Authorized redirect URI: `https://your-app.vercel.app/api/google-callback`
   (use your real Vercel domain).
5. Put the **Client ID** in [`google.html`](google.html) (`const CLIENT_ID = '...'`), and add
   these in Vercel → **Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | your OAuth client's Client ID |
| `GOOGLE_CLIENT_SECRET` | your OAuth client's Client Secret (**secret**) |

6. Open the site at that exact domain → **Today** hub → **Google** tile → **Connect Google**.

> **Testing-mode caveat:** while the OAuth consent screen is in "Testing" status, Google
> expires the connection after about 7 days regardless of activity — you'll just need to
> tap **Connect Google** again when that happens. Submitting the app for Google's (free,
> lightweight) verification review removes this limit, but isn't required to use it.

---

## 6. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com.

---

## 7. Text reminders (optional)

`main.html`'s "Recurring Items" list (Gym, Water, Read, etc.) — and any one-off to-do you've
given a time via the Schedule/Calendar time field — can text you individually, right around
each item's own scheduled time, instead of one bundled digest of everything undone. This runs
entirely server-side on a schedule — it doesn't need the dashboard open in a browser. It reuses
your existing Supabase `SUPABASE_URL`/`SUPABASE_ANON_KEY` from step 2, so nothing extra needed
there. Pick **one** of the delivery methods below — if you've set up the **Telegram Assistant**
(step 8), it's already covered and you can skip this whole section: Telegram is preferred
automatically over Twilio, which is preferred over the email gateway, whenever more than one
happens to be configured.

**How the timing works:** each recurring item can have a time set in the Recurring Items form
(and a one-off to-do can have one via the Schedule/Calendar view). If it doesn't:
- a name containing `(PM)` or "evening" defaults to shortly before your `BEDTIME_LOCAL` (below);
- a name containing `(AM)` or "morning" defaults to 8:00am;
- anything else with no time and no AM/PM hint has no single moment of its own — it's swept
  into one combined "still open" digest sent once a day, ~30 minutes before bedtime.

A small (±10 minute) deterministic jitter is applied per item per day, so reminders don't land
at the exact same robotic minute every day. If something's still undone once its time arrives,
it nags again every 90 minutes until you mark it done or until `BEDTIME_LOCAL` passes, after
which it goes quiet for the day rather than pinging you overnight.

**Gym reminders are pushed back after a bad night's sleep:** if last night's Peak morning
check-in logged a sleep quality of 2 or lower, any recurring item that looks like a gym/workout
reminder (matching "gym", "workout", or "lift" in its name) has its effective time delayed by 90
minutes that day. The idea is to not nag you to hit the gym at your usual time when you're
clearly running on too little sleep — everything else on your list still reminds you at its
normal time.

**Feeling/stress check-ins (Peak tab) work differently on purpose:** unlike everything else
above, these are meant to happen several times a day, so a single "done today" flag doesn't fit.
Instead, starting at 9am, you get a prompt roughly every 4 hours whenever there hasn't been an
actual logged check-in (spontaneous or via the assistant) in that window — logging one resets
the 4-hour clock immediately, and it goes quiet once `BEDTIME_LOCAL` passes, same as everything
else.

**Subscription renewals (Finance tab) work differently too:** rather than a daily nag, you get a
one-time heads-up 3 days before each subscription's renewal date (and again isn't sent for that
same renewal once it's fired — the next one only fires ahead of the *following* cycle). Covers
every subscription with a renewal date set, whether or not it's linked to an account for
auto-deduct — a heads-up is still useful even for ones that charge automatically.

**A daily morning briefing** goes out once a day at `MORNING_BRIEFING_TIME` (24h `HH:MM`,
default `07:00`) — a single message listing everything scheduled today and still undone
(recurring items plus any timed one-off to-dos), last night's logged sleep quality if you've
been using the Peak morning check-in, and a nod to any subscription renewals coming up soon.
It's a one-shot per day, same as the catch-all digest, so it won't repeat once sent.

**Option A — free, via your carrier's email-to-SMS gateway (recommended to start if you're not using Telegram):**

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
| `BEDTIME_LOCAL` | 24h `HH:MM`, e.g. `23:00` (default if unset) — the cutoff for nagging, and the anchor for `(PM)`/evening items with no explicit time |
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
| `REMINDER_TIMEZONE` / `BEDTIME_LOCAL` / `CRON_SECRET` | same as Option A above |

**Either way:**

3. Redeploy after adding the env vars above.
4. Scheduling runs on **GitHub Actions**, not Vercel Cron — see
   [`.github/workflows/reminders.yml`](.github/workflows/reminders.yml). Vercel's free Hobby
   plan only allows cron schedules that fire once a day each, which can't do this; a scheduled
   GitHub Actions workflow on a public repo is free at any frequency, so that's what pings
   `/api/send-reminders` every 15 minutes instead ([`vercel.json`](vercel.json) is intentionally
   empty). To turn it on:
   - Repo → **Settings → Secrets and variables → Actions → New repository secret** → name it
     `CRON_SECRET`, value = the **same** random string you set as the `CRON_SECRET` env var in
     Vercel (step 3 above). This is what lets the workflow call your endpoint without exposing
     it publicly.
   - That's it — the workflow is already scheduled every 15 minutes, roughly 6am-1am
     America/New_York during EDT (it skips a small 2am-6am dead zone overnight). It'll start
     firing on the next tick, or trigger it immediately yourself: repo → **Actions** tab →
     **Dashboard reminders** → **Run workflow**.
   - The function itself decides *whether anything's actually due right now* on every tick —
     each item's own scheduled time (or the bedtime-anchored default, or the once-daily
     catch-all) is the real gate, not how often the workflow happens to ping the endpoint.

   > **Twice a year**, around DST changes (mid-March, early November), the workflow's fixed UTC
   > cron hours land an hour off from local time for about a week until manually nudged — ticks
   > just happen an hour later/earlier than intended for a few days rather than at the wrong
   > time entirely (15-minute granularity means it's a minor drift, not a missed day). If that
   > bothers you, edit the `cron:` line in `.github/workflows/reminders.yml` by ±1 hour.
5. Give your recurring items (Recurring Items panel, Main tab) and any one-off to-dos you want
   reminders for (Schedule/Calendar time field) a time — anything with no `CRON_SECRET` set is
   reachable by anyone who finds the URL, who could then spam your phone or burn through your
   quota, so set it.

---

## 8. Telegram Assistant (optional)

A two-way personal assistant, reachable from the regular Telegram app on your phone — not
just a one-way reminder text. It can see and act on essentially the whole dashboard (same
Supabase rows the dashboard itself reads/writes): to-dos, recurring items, daily habits, gym
(workout sets, exercises, cardio, stretch routines, body weight), water/supplements, finances
(net worth accounts, purchases, subscriptions, debts, orders, wishlist), side-hustle business
(affiliate commitments/revenue, editing clients/deliveries/payments), reading, Peak (morning
check-in — wake time/resting heart rate/sleep hours/sleep quality — and feeling/stress
check-ins, which it understands can happen several times a day rather than just once), the
food/calorie/macro log, caffeine and nicotine intake, and free-form notes. Ask it questions
about any of it, or tell it to log/change things directly — "log a $20 grocery run", "mark gym
done", "log 3 sets of bench at 135 for 8 reps", "cancel my Hulu subscription", "add $50 to
checking", "I finished chapter 3 of Atomic Habits", "good morning, slept 7.5 hours, sleep was a
4", "feeling a 3, stress at 4 right now", "track a Red Bull and a chicken burrito bowl", "note
that the landlord called about the lease" — names (exercises, clients, books, accounts, habits)
are matched loosely, so it doesn't need to be word-for-word. There's no hardcoded food/drink
database behind the calorie/caffeine/nicotine tools — the assistant estimates calories, macros,
and mg from its own general knowledge (the same way the dashboard's own AI photo-estimate
feature works), so you don't need to give it exact numbers for common items. It also takes over
the recurring-item reminder texts from step 7 above once configured, including the periodic
feeling-check-in prompts described there.

You can also just send a **photo** of food or a drink instead of typing it out — with or without
a caption — and it identifies what's in the photo and logs it the same estimate-from-general-
knowledge way. Add a caption if you want to steer the estimate (portion size, what's mixed in,
etc.); without one it just describes what it logged in its reply so you can correct it if the
guess is off.

The Finance tab's **Debts** tab tracks loans/credit card balances separately from your net worth
accounts, with a payoff calculator (avalanche vs snowball, compares total interest and time to
debt-free for a given extra monthly payment). Add a debt from the tab directly or via chat
("add a car loan, $10k at 6% APR, $220 minimum"). Subscriptions also now flag **price creep** —
a badge shows up once a subscription's price has genuinely risen since you first started
tracking it, plus a running total of how much of your monthly subscription burn is drift rather
than the price you originally signed up for.

The Net Worth tab also has a **Forecast** card: it fits a trend line to your existing net-worth
history (the same data already behind the trend chart — no new setup needed) and projects
forward — a running "trending +$X/mo" readout, a milestone ("at this rate: $X by &lt;month&gt;"),
a custom goal amount you can type in for its own projected date, and a "what would spending this
cost my timeline" quick check for a hypothetical purchase. Needs a few days of real tracked
history before it has enough to fit a trend line — it says so plainly rather than guessing from
too little data.

Marking things done across the dashboard (to-dos, habits, gym days, stretch routines, logging
body weight) now also earns **XP** — a small toast pops up, levels climb on a steepening curve
(level 2 at 100 XP, level 5 at 1,500, level 10 at 5,500), and badges unlock for milestones (first
action logged, 100/500/1,000 total XP, 10/50 gym days, 25 habits/to-dos, reaching level 5/10,
etc.). It's a no-setup, always-on layer — nothing to configure, and it only fires on the
transition into "done," so unchecking and rechecking something can't farm XP. One honest
limitation: this state lives in `localStorage` only (not synced through Supabase like the rest of
the dashboard), so XP/levels/badges are currently per-device rather than shared between your
phone and laptop.

Marking gym day, a habit, or a stretch routine done tells you the current streak too (matching
the 🔥 counters already on the Main and Gym tabs) when it's more than a day or two — same
"today counts, or falls back to yesterday if today's not done yet" rule as those counters, so an
unlogged today doesn't look like a broken streak before the day's actually over.

If it logs something wrong — misheard a name, wrong amount, wrong exercise — just say "undo
that" and it reverts the single most recent change exactly, rather than you having to work out
the opposite correction yourself. It only keeps one level of undo (the very last thing it did),
not a full history.

> Not covered: Avatar Lab and the weekly/monthly Review tab's reflection notes are local-feeling
> pages the assistant intentionally doesn't touch — the former has no synced data at all, and the
> latter's "what went well / what would you change" fields are meant to be a deliberate sit-down
> writing exercise rather than something to dash off in a text.

You can also ask it to set up new recurring reminders on the fly — e.g. "remind me to do a
morning check-in every day at 8am" — which adds a new entry to the Recurring Items panel
(Main tab) the same way filling out that form yourself would, without needing a redeploy.

For a **one-off** reminder on a specific day instead of something recurring — "remind me to
renew my passport in 3 months," "remind me to call the dentist next Tuesday at 2pm" — it adds a
to-do to that day's Schedule/Calendar entry directly (same as picking that date in the Calendar
tab and typing it in yourself), and it'll get reminded on its own once that day arrives.

Every individual item reminder (not the once-daily catch-all digest, subscription heads-up, or
morning briefing — just the "your time is up for this one thing" nudges) comes with a tappable
**✅ Done** button, so you don't have to type anything back to mark it done — one tap, and the
message updates in place to confirm it. It's exactly equivalent to texting "mark X done" — same
fuzzy name matching, same materialization of a not-yet-opened-today recurring item — just without
having to type.

Calendar/Gmail/Drive (step 5) can be included too — see the separate **"Connect Google to the
assistant"** steps further down, after the core setup below.

1. In the Telegram app, message **@BotFather** → `/newbot` → give it a name, then a
   username ending in `bot` (must be unique). It replies with a **bot token** —
   `123456789:AAExampleTokenStringHere`. Treat this like a password.
2. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | any random string you make up (20+ characters) — locks the webhook so only real Telegram requests get through |
| `ANTHROPIC_API_KEY` | an Anthropic API key (**console.anthropic.com** → API Keys) — this runs server-side, separate from the key saved in Nova's browser `localStorage` |

3. Redeploy so those env vars take effect.
4. Visit `https://your-app.vercel.app/api/telegram-set-webhook?secret=<your TELEGRAM_WEBHOOK_SECRET>`
   once, in your own browser — this registers the webhook with Telegram. You should get back a
   small JSON blob with `"ok":true`.
5. Open a chat with your bot in Telegram (search its username) and send it any message. Since
   `TELEGRAM_CHAT_ID` isn't set yet, it'll reply with **your chat ID** instead of doing anything
   else — copy that number.
6. Back in Vercel env vars, add `TELEGRAM_CHAT_ID` = that number, and redeploy. From then on,
   the bot only responds to messages from that chat — anyone else who finds its username gets
   silently ignored.
7. Message it again — it should now actually respond, using your real dashboard data.

> Every write the assistant makes goes through the exact same Supabase rows and data shapes the
> dashboard's own pages use, so anything it logs shows up in the normal UI immediately (and vice
> versa) — there's no separate/shadow data store.

> **Memory:** the assistant remembers roughly your last 10 exchanges (its own Supabase row, not
> tied to any one device), so you can say "log another set of that" or ask a follow-up without
> repeating context. It doesn't remember indefinitely — very old messages roll off automatically
> once the limit is hit.

> **Checking off a recurring item (e.g. "mark Skin care done"):** works even if you haven't
> opened the Main tab yet today — the assistant matches it against the Recurring Items list
> directly rather than only searching today's already-generated to-do list.

> **Real sleep tracking instead of an estimate:** text it "going to bed" (or "heading to sleep",
> "night") right when you're about to fall asleep, and it marks the moment. The next time you
> text it anything that sounds like waking up — "good morning" alone is enough, no other details
> needed — it computes your actual sleep duration and wake time from the real elapsed time and
> logs them on the Peak tab's morning check-in, same as if you'd typed the numbers in yourself.
> Mention resting heart rate or a sleep-quality rating in that same wake-up message and those get
> logged too. If you explicitly state a sleep-hours number yourself ("slept about 6"), that wins
> over the tracked time. Skipping `log_bedtime` entirely still works exactly like before — this is
> purely additive, not a requirement.

> **API cost tracking:** ask "how much have I spent on you this month" (or today, or all-time)
> and it'll answer from a running tally of every Anthropic call it's made — token counts in, an
> estimated USD cost out. The cost is only an ESTIMATE from configurable per-token prices
> (`ANTHROPIC_INPUT_PRICE_PER_MTOK` / `ANTHROPIC_OUTPUT_PRICE_PER_MTOK` env vars, default $3 / $15
> per million tokens), not a real invoice figure — Anthropic's actual pricing can change and this
> has no way to know that on its own, so update those env vars if it drifts. Check
> **console.anthropic.com**'s usage dashboard for the authoritative number.

### Connect Google to the assistant (optional, needs step 5 done first)

Everything above works without this — the assistant just won't know about your Calendar,
Gmail, or Drive. Adding it is a bit more setup than the rest of this guide, on purpose: a
Google OAuth token is a real credential that can read your actual inbox/calendar, and it
deserves better protection than the public key every other piece of dashboard data syncs
through. So Google's tokens live in their **own** Supabase table, locked down so only this
server-side function — never the browser, never the public key baked into the site's JS — can
read it.

1. In the **Supabase SQL Editor**, run once:
   ```sql
   create table if not exists google_tokens (
     id int primary key default 1,
     access text, refresh text, expires bigint,
     updated_at timestamptz default now()
   );
   alter table google_tokens enable row level security;
   -- No policies added on purpose — this blocks the public anon key entirely.
   -- Only the service_role key (next step) can read or write this table.
   ```
2. In Supabase → **Settings → API**, copy the **`service_role`** secret key (different from
   the `anon`/`publishable` key `sync.js` already uses — this one must never be pasted into
   any HTML/JS file or exposed to a browser).
3. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key from step 2 — **server-side only** |
| `GOOGLE_SYNC_SECRET` | any random string you make up — a basic gate on the token-sync endpoint (not what protects confidentiality; the table having no anon policies is what does that) |

4. Redeploy. From then on, every time `google.html` saves a token (initial connect or a
   background refresh), it also pushes a copy to `/api/google-token-sync`, which lands in the
   locked-down table above. Nothing to do on your end beyond having Google connected (step 5) —
   the next time you open `google.html`, or the assistant runs, it picks this up automatically.
5. Message the assistant something like "what's on my calendar today" to confirm it's working.
   If Google isn't connected yet, or the connection has lapsed, it'll say so rather than
   guessing — reconnect via `google.html` in that case.

> **Calendar write access:** the assistant can also create, reschedule, and cancel REAL events
> on your actual Google Calendar — "schedule a dentist appointment Tuesday at 2pm", "move my 3pm
> to 4pm", "cancel the dentist thing" — not just to-dos on the dashboard's own Schedule/Calendar
> view (that's what `add_todo` is for). This needs the `calendar.events` scope from step 5 above;
> if you connected Google before this was added, the stored token only has the old read-only
> grant — hit **Disconnect** then **Connect Google** again on the Google tile to re-grant it.
> Unlike everything else the assistant does, these writes hit a real external account directly,
> not the dashboard's own Supabase data — `undo_last_action` does not cover them, so a mistaken
> delete/reschedule has to be fixed by hand (or from Google Calendar itself).

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`,
   `topbar.js`, `gym.html`.
3. (Optional) WHOOP: Client ID in `health.html` + the two env vars in Vercel.
4. (Optional) Apple Health: `APPLE_HEALTH_SECRET` env var + an iOS Shortcut, see step 4 above.
5. (Optional) Google: Client ID in `google.html` + the two env vars in Vercel, see step 5 above.
6. (Optional) Text reminders: Resend (free) or Twilio (paid) + the env vars in step 7 above —
   skip if using the Telegram Assistant, which covers this too.
7. (Optional) Telegram Assistant: bot token + env vars in step 8 above.
8. (Optional) Connect Google to the assistant: the `google_tokens` SQL + `SUPABASE_SERVICE_ROLE_KEY`/`GOOGLE_SYNC_SECRET` env vars, see step 8 above.
9. Change the password in `lock.js`. Done.
