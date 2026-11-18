-- Talk with Masahiro — schema
--
-- Who writes what:
--   browser (anon key + user JWT, RLS)   reads its own rows; toggles `mastered`
--   Next.js route handlers (user JWT)    start_practice_session() — quota check
--   orchestrator (service role key)      record_session_end() — transcript words
--
-- The quota lives in the database, not in app code: the check and the insert
-- happen in one function under a per-user advisory lock, so two tabs racing
-- "Start" cannot both slip under the limit.

-- ── profiles ─────────────────────────────────────────────────────────────────

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  -- Sessions per day (Asia/Tokyo). Each session bills LiveAvatar + OpenAI, so
  -- the public default is small; raise it per user in the dashboard.
  daily_limit integer not null default 3 check (daily_limit >= 0),
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── practice_sessions ────────────────────────────────────────────────────────

create table public.practice_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  mode                text not null default 'english_coach',
  -- starting → ended | failed. "starting" rows that never end (orchestrator
  -- crash) still count toward the quota, which is the safe direction.
  status              text not null default 'starting'
                        check (status in ('starting', 'ended', 'failed')),
  upstream_session_id text,
  end_reason          text,
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  duration_sec        integer
);

create index practice_sessions_user_started_idx
  on public.practice_sessions (user_id, started_at desc);

alter table public.practice_sessions enable row level security;

create policy "sessions: read own" on public.practice_sessions
  for select using (auth.uid() = user_id);

-- ── words (the wordbook) ─────────────────────────────────────────────────────
-- One row per user per term; every session that shows the term links to it.

create table public.words (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  term             text not null check (char_length(term) between 1 and 80),
  term_key         text generated always as (lower(btrim(term))) stored,
  reading          text check (char_length(reading) <= 120),
  meaning          text check (char_length(meaning) <= 120),
  times_seen       integer not null default 1,
  mastered         boolean not null default false,
  first_learned_at timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  unique (user_id, term_key)
);

alter table public.words enable row level security;

create policy "words: read own" on public.words
  for select using (auth.uid() = user_id);

-- The only column the browser may change.
create policy "words: update own" on public.words
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke update on public.words from anon, authenticated;
grant update (mastered) on public.words to authenticated;

create table public.session_words (
  session_id uuid not null references public.practice_sessions (id) on delete cascade,
  word_id    uuid not null references public.words (id) on delete cascade,
  position   integer not null,
  primary key (session_id, word_id)
);

alter table public.session_words enable row level security;

create policy "session_words: read own" on public.session_words
  for select using (
    exists (select 1 from public.practice_sessions s
            where s.id = session_id and s.user_id = auth.uid())
  );

-- ── RPC: start_practice_session (called with the user's JWT) ─────────────────

create function public.start_practice_session(p_mode text default 'english_coach')
returns table (session_id uuid, used_today integer, daily_limit integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_user  uuid := auth.uid();
  v_limit integer;
  v_used  integer;
  v_id    uuid;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_mode not in ('english_coach') then
    raise exception 'unknown_mode' using errcode = '22023';
  end if;

  -- Serialise this user's starts so check-then-insert is atomic.
  perform pg_advisory_xact_lock(hashtext(v_user::text));

  insert into public.profiles (id) values (v_user) on conflict do nothing;
  select p.daily_limit into v_limit from public.profiles p where p.id = v_user;

  select count(*) into v_used
  from public.practice_sessions s
  where s.user_id = v_user
    and s.status <> 'failed'
    and s.started_at >= (date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo');

  if v_used >= v_limit then
    raise exception 'daily_limit_reached' using errcode = 'P0001';
  end if;

  insert into public.practice_sessions (user_id, mode)
  values (v_user, p_mode)
  returning id into v_id;

  return query select v_id, v_used + 1, v_limit;
end;
$$;

revoke all on function public.start_practice_session(text) from public, anon;
grant execute on function public.start_practice_session(text) to authenticated;

-- ── RPC: fail_practice_session (user JWT) ────────────────────────────────────
-- The orchestrator could not start the avatar: give the quota slot back.

create function public.fail_practice_session(p_session_id uuid, p_reason text default null)
returns void
language sql security definer set search_path = '' as $$
  update public.practice_sessions
     set status = 'failed', ended_at = now(), end_reason = left(p_reason, 200)
   where id = p_session_id and user_id = auth.uid() and status = 'starting';
$$;

revoke all on function public.fail_practice_session(uuid, text) from public, anon;
grant execute on function public.fail_practice_session(uuid, text) to authenticated;

-- ── RPC: usage_today (user JWT) ──────────────────────────────────────────────

create function public.usage_today()
returns table (used_today integer, daily_limit integer)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*)::integer from public.practice_sessions s
      where s.user_id = auth.uid() and s.status <> 'failed'
        and s.started_at >= (date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo')),
    coalesce((select p.daily_limit from public.profiles p where p.id = auth.uid()), 3);
$$;

revoke all on function public.usage_today() from public, anon;
grant execute on function public.usage_today() to authenticated;

-- ── RPC: record_session_end (orchestrator, service role only) ────────────────
-- p_words: [{ "term": "...", "reading": "...", "meaning": "..." }, ...] in
-- teaching order. Idempotent per session: a second call is a no-op.

create function public.record_session_end(
  p_session_id          uuid,
  p_upstream_session_id text,
  p_reason              text,
  p_duration_sec        integer,
  p_words               jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_word jsonb;
  v_word_id uuid;
  v_pos integer := 0;
begin
  update public.practice_sessions
     set status = 'ended',
         ended_at = now(),
         end_reason = left(p_reason, 200),
         upstream_session_id = left(p_upstream_session_id, 200),
         duration_sec = greatest(0, p_duration_sec)
   where id = p_session_id and status = 'starting'
  returning user_id into v_user;

  if v_user is null then
    return; -- unknown or already recorded
  end if;

  for v_word in select * from jsonb_array_elements(coalesce(p_words, '[]'::jsonb)) limit 100
  loop
    continue when coalesce(btrim(v_word ->> 'term'), '') = '';
    v_pos := v_pos + 1;

    insert into public.words as w (user_id, term, reading, meaning)
    values (
      v_user,
      left(btrim(v_word ->> 'term'), 80),
      left(nullif(btrim(v_word ->> 'reading'), ''), 120),
      left(nullif(btrim(v_word ->> 'meaning'), ''), 120)
    )
    on conflict (user_id, term_key) do update
      set times_seen   = w.times_seen + 1,
          last_seen_at = now(),
          reading      = coalesce(excluded.reading, w.reading),
          meaning      = coalesce(excluded.meaning, w.meaning)
    returning id into v_word_id;

    insert into public.session_words (session_id, word_id, position)
    values (p_session_id, v_word_id, v_pos)
    on conflict do nothing;
  end loop;
end;
$$;

revoke all on function public.record_session_end(uuid, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_session_end(uuid, text, text, integer, jsonb)
  to service_role;
