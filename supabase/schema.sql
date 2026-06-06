create extension if not exists pgcrypto;

create table if not exists public.game_players (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null,
  team text check (team in ('red', 'green')),
  room_code text not null default 'main',
  lat double precision,
  lng double precision,
  accuracy integer,
  is_online boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.game_rooms (
  room_code text primary key,
  status text not null default 'lobby' check (status in ('lobby', 'started', 'ended')),
  red_slots integer check (red_slots is null or red_slots >= 0),
  green_slots integer check (green_slots is null or green_slots >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);

alter table public.game_rooms
  add column if not exists broadcast_message text,
  add column if not exists broadcast_sender text,
  add column if not exists broadcast_at timestamptz;

alter table public.game_rooms
  add column if not exists red_score integer not null default 0;

alter table public.game_players
  add column if not exists capture_code text,
  add column if not exists rescue_code text,
  add column if not exists is_captured boolean not null default false,
  add column if not exists captured_at timestamptz;

create table if not exists public.game_rescue_attempts (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.game_rooms(room_code) on delete cascade,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  rescuer_id uuid not null references auth.users(id) on delete cascade,
  rescue_code text not null,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now()
);

create index if not exists game_rescue_attempts_lookup_idx
  on public.game_rescue_attempts (room_code, rescue_code, target_user_id, created_at desc);

create table if not exists public.player_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  updated_at timestamptz not null default now()
);

create table if not exists public.control_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create index if not exists game_players_room_code_idx
  on public.game_players (room_code);

create index if not exists game_players_updated_at_idx
  on public.game_players (updated_at desc);

alter table public.game_players enable row level security;
alter table public.game_rooms enable row level security;
alter table public.player_profiles enable row level security;
alter table public.control_operators enable row level security;
alter table public.game_rescue_attempts enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.game_players to authenticated;
grant select, insert, update, delete on public.game_rooms to authenticated;
grant select, insert, update, delete on public.player_profiles to authenticated;
grant select on public.control_operators to authenticated;
grant delete on public.game_rescue_attempts to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'game_players_team_check'
      and conrelid = 'public.game_players'::regclass
  ) then
    alter table public.game_players drop constraint game_players_team_check;
  end if;
end $$;

alter table public.game_players
  alter column team drop not null;

alter table public.game_players
  add constraint game_players_team_check
  check (team is null or team in ('red', 'green'));

create or replace function public.is_control_operator()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.control_operators operator
    where operator.user_id = auth.uid()
  );
$$;

revoke all on function public.is_control_operator() from public;
grant execute on function public.is_control_operator() to authenticated;

create or replace function public.can_update_own_player_row(
  p_user_id uuid,
  p_room_code text,
  p_team text
)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  current_room_code text;
  current_team text;
  current_room_status text;
begin
  if p_user_id is null or p_user_id <> auth.uid() then
    return false;
  end if;

  select player.room_code, player.team, room.status
    into current_room_code, current_team, current_room_status
  from public.game_players player
  left join public.game_rooms room
    on room.room_code = player.room_code
  where player.user_id = p_user_id;

  if not found then
    return false;
  end if;

  if current_room_code is distinct from p_room_code then
    return false;
  end if;

  if current_room_status = 'lobby' then
    return true;
  end if;

  return current_team is not distinct from p_team;
end;
$$;

revoke all on function public.can_update_own_player_row(uuid, text, text) from public;
grant execute on function public.can_update_own_player_row(uuid, text, text) to authenticated;

create or replace function public.dedupe_rescue_attempt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.game_rescue_attempts
  where room_code = new.room_code
    and target_user_id = new.target_user_id
    and rescue_code = new.rescue_code
    and rescuer_id = new.rescuer_id;

  return new;
end;
$$;

revoke all on function public.dedupe_rescue_attempt() from public;

drop trigger if exists dedupe_rescue_attempt_before_insert on public.game_rescue_attempts;
create trigger dedupe_rescue_attempt_before_insert
before insert on public.game_rescue_attempts
for each row
execute function public.dedupe_rescue_attempt();

drop policy if exists "Operators can read own operator row" on public.control_operators;
create policy "Operators can read own operator row"
on public.control_operators
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Authenticated users can read game rooms" on public.game_rooms;
create policy "Authenticated users can read game rooms"
on public.game_rooms
for select
to authenticated
using (true);

drop policy if exists "Operators can create game rooms" on public.game_rooms;
create policy "Operators can create game rooms"
on public.game_rooms
for insert
to authenticated
with check (public.is_control_operator());

drop policy if exists "Operators can update game rooms" on public.game_rooms;
create policy "Operators can update game rooms"
on public.game_rooms
for update
to authenticated
using (public.is_control_operator())
with check (public.is_control_operator());

drop policy if exists "Operators can delete game rooms" on public.game_rooms;
create policy "Operators can delete game rooms"
on public.game_rooms
for delete
to authenticated
using (public.is_control_operator());

drop policy if exists "Operators can delete rescue attempts" on public.game_rescue_attempts;
create policy "Operators can delete rescue attempts"
on public.game_rescue_attempts
for delete
to authenticated
using (public.is_control_operator());

drop policy if exists "Players can read their own profile" on public.player_profiles;
create policy "Players can read their own profile"
on public.player_profiles
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Players can create their own profile" on public.player_profiles;
create policy "Players can create their own profile"
on public.player_profiles
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Players can update their own profile" on public.player_profiles;
create policy "Players can update their own profile"
on public.player_profiles
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create or replace function public.can_view_game_player(target_room text, target_team text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.game_players viewer
    join public.game_rooms room
      on room.room_code = viewer.room_code
    where viewer.user_id = auth.uid()
      and viewer.room_code = target_room
      and viewer.team is not null
      and target_team is not null
      and viewer.team <> target_team
      and room.status = 'started'
  );
$$;

revoke all on function public.can_view_game_player(text, text) from public;
grant execute on function public.can_view_game_player(text, text) to authenticated;

create or replace function public.generate_game_code()
returns text
language sql
volatile
as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
$$;

revoke all on function public.generate_game_code() from public;
grant execute on function public.generate_game_code() to authenticated;

create or replace function public.generate_room_game_code(p_room_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  next_code text;
begin
  loop
    next_code := public.generate_game_code();
    exit when not exists (
      select 1
      from public.game_players player
      where player.room_code = p_room_code
        and (player.capture_code = next_code or player.rescue_code = next_code)
    );
  end loop;

  return next_code;
end;
$$;

revoke all on function public.generate_room_game_code(text) from public;
grant execute on function public.generate_room_game_code(text) to authenticated;

create or replace function public.distance_meters(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql
immutable
as $$
  select sqrt(
    power((lat1 - lat2) * 111000, 2) +
    power((lng1 - lng2) * 111000 * cos(radians(coalesce(lat1, 0))), 2)
  );
$$;

revoke all on function public.distance_meters(double precision, double precision, double precision, double precision) from public;
grant execute on function public.distance_meters(double precision, double precision, double precision, double precision) to authenticated;

create or replace function public.submit_game_code(
  p_room_code text,
  p_code text,
  p_lat double precision default null,
  p_lng double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor public.game_players%rowtype;
  target public.game_players%rowtype;
  other_attempt public.game_rescue_attempts%rowtype;
  normalized_code text;
  new_code text;
  rescue_window_seconds integer := 3;
  rescue_distance_meters integer := 30;
begin
  normalized_code := upper(trim(coalesce(p_code, '')));
  if normalized_code = '' then
    return jsonb_build_object('ok', false, 'type', 'empty', 'message', 'Please enter a code.');
  end if;

  select *
    into actor
  from public.game_players
  where user_id = auth.uid()
    and room_code = p_room_code
  for update;

  if not found or actor.team is null then
    return jsonb_build_object('ok', false, 'type', 'not_joined', 'message', 'You are not in this game room.');
  end if;

  if not exists (
    select 1 from public.game_rooms room
    where room.room_code = p_room_code
      and room.status = 'started'
  ) then
    return jsonb_build_object('ok', false, 'type', 'not_started', 'message', 'Game has not started.');
  end if;

  if actor.team = 'red' then
    select *
      into target
    from public.game_players
    where room_code = p_room_code
      and team = 'green'
      and is_captured = false
      and capture_code = normalized_code
    for update;

    if not found then
      return jsonb_build_object('ok', false, 'type', 'capture_failed', 'message', 'Capture failed. No active green code matched.');
    end if;

    new_code := public.generate_room_game_code(p_room_code);
    update public.game_players
      set capture_code = null,
          rescue_code = new_code,
          is_captured = true,
          captured_at = now(),
          updated_at = now()
    where user_id = target.user_id;

    update public.game_rooms
      set red_score = coalesce(red_score, 0) + 1,
          updated_at = now()
    where room_code = p_room_code;

    delete from public.game_rescue_attempts
    where room_code = p_room_code
      and target_user_id = target.user_id;

    return jsonb_build_object(
      'ok', true,
      'type', 'capture_success',
      'message', 'Capture success.',
      'target_user_id', target.user_id,
      'target_name', target.display_name,
      'rescue_code', new_code
    );
  end if;

  if actor.team = 'green' then
    if actor.is_captured then
      return jsonb_build_object('ok', false, 'type', 'rescuer_captured', 'message', 'Captured players cannot rescue teammates.');
    end if;

    select *
      into target
    from public.game_players
    where room_code = p_room_code
      and team = 'green'
      and is_captured = true
      and rescue_code = normalized_code
      and user_id <> auth.uid()
    for update;

    if not found then
      return jsonb_build_object('ok', false, 'type', 'rescue_failed', 'message', 'Rescue failed. No captured teammate code matched.');
    end if;

    delete from public.game_rescue_attempts
    where created_at < now() - make_interval(secs => rescue_window_seconds);

    select *
      into other_attempt
    from public.game_rescue_attempts attempt
    where attempt.room_code = p_room_code
      and attempt.target_user_id = target.user_id
      and attempt.rescue_code = normalized_code
      and attempt.rescuer_id <> auth.uid()
      and attempt.created_at >= now() - make_interval(secs => rescue_window_seconds)
      and public.distance_meters(coalesce(p_lat, actor.lat), coalesce(p_lng, actor.lng), attempt.lat, attempt.lng) <= rescue_distance_meters
    order by attempt.created_at desc
    limit 1;

    if found then
      new_code := public.generate_room_game_code(p_room_code);
      update public.game_players
        set capture_code = new_code,
            rescue_code = null,
            is_captured = false,
            captured_at = null,
            updated_at = now()
      where user_id = target.user_id;

      delete from public.game_rescue_attempts
      where room_code = p_room_code
        and target_user_id = target.user_id;

      return jsonb_build_object(
        'ok', true,
        'type', 'rescue_success',
        'message', 'Rescue success.',
        'target_user_id', target.user_id,
        'target_name', target.display_name,
        'capture_code', new_code
      );
    end if;

    insert into public.game_rescue_attempts (room_code, target_user_id, rescuer_id, rescue_code, lat, lng)
    values (p_room_code, target.user_id, auth.uid(), normalized_code, coalesce(p_lat, actor.lat), coalesce(p_lng, actor.lng));

    return jsonb_build_object(
      'ok', true,
      'type', 'rescue_waiting',
      'message', 'Rescue code submitted. Another green teammate must submit the same code at the same place within 3 seconds.',
      'target_user_id', target.user_id,
      'target_name', target.display_name
    );
  end if;

  return jsonb_build_object('ok', false, 'type', 'invalid_team', 'message', 'Invalid team state.');
end;
$$;

revoke all on function public.submit_game_code(text, text, double precision, double precision) from public;
grant execute on function public.submit_game_code(text, text, double precision, double precision) to authenticated;

drop policy if exists "Players can view visible room players" on public.game_players;
create policy "Players can view visible room players"
on public.game_players
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_control_operator()
  or public.can_view_game_player(room_code, team)
);

drop policy if exists "Players can create their own row" on public.game_players;
create policy "Players can create their own row"
on public.game_players
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.game_rooms room
    where room.room_code = game_players.room_code
      and room.status = 'lobby'
  )
);

drop policy if exists "Players can update their own row" on public.game_players;
create policy "Players can update their own row"
on public.game_players
for update
to authenticated
using (user_id = auth.uid())
with check (public.can_update_own_player_row(user_id, room_code, team));

drop policy if exists "Operators can update all game players" on public.game_players;
create policy "Operators can update all game players"
on public.game_players
for update
to authenticated
using (public.is_control_operator())
with check (public.is_control_operator());

drop policy if exists "Operators can delete all game players" on public.game_players;
create policy "Operators can delete all game players"
on public.game_players
for delete
to authenticated
using (public.is_control_operator());

drop policy if exists "Players can delete their own row" on public.game_players;
create policy "Players can delete their own row"
on public.game_players
for delete
to authenticated
using (user_id = auth.uid());

do $$
begin
  alter publication supabase_realtime add table public.game_players;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.game_rooms;
exception
  when duplicate_object then null;
end $$;
