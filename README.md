# Fernando's Dashboard (simple)

4 tabs. Nothing else.

| Tab | File | What |
|---|---|---|
| Today | index.html | The 3 daily checks (gym, 1h money work, clean day), week score /21, max 3 to-dos |
| Gym | gym.html | Progressive overload tracker, weight, cardio, stretching |
| Body | health.html | Supplement stack + water (po-water.html) |
| Money | money.html | Monthly recurring vs the $1,000 goal |

Data: `data.json` is written by `~/life-os/publish.py` from `~/life-os/log.csv` (Hermes nightly iMessage check-in) and `~/life-os/money.json`. Taps on the Today tab are saved on the phone; Hermes' log wins once that night is logged.

The old 38-page version is tagged `pre-simple-2026-10-17`.

## Gym sync (2026-11-09)

The Gym tab (program: Mon Upper, Tue Lower, Wed Push, Thu Pull, Fri Legs, in lb) saves on the phone and pushes one JSONB row (`key = 'po-coach'`) to `public.app_state` in the midterm-mastery Supabase project. `~/life-os/gym_pull.py` reads that row for the weekly review. The program before this change is tagged `pre-mf-program-2026-11-09`.

Table setup (already run):

```sql
create table if not exists public.app_state (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_state enable row level security;
grant select, insert, update on table public.app_state to anon, authenticated;
revoke delete, truncate, references, trigger on table public.app_state from anon, authenticated;
create policy "app_state anon select" on public.app_state for select to anon, authenticated using (true);
create policy "app_state anon insert" on public.app_state for insert to anon, authenticated with check (true);
create policy "app_state anon update" on public.app_state for update to anon, authenticated using (true) with check (true);
alter publication supabase_realtime add table public.app_state;
```

The browser uses the publishable key, so anyone with the page source can read or overwrite this row (no delete). Export a JSON backup from Gym settings now and then.
