create extension if not exists pgcrypto;

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

alter table public.game_rescue_attempts enable row level security;

grant delete on public.game_rescue_attempts to authenticated;

drop policy if exists "Operators can delete rescue attempts" on public.game_rescue_attempts;
create policy "Operators can delete rescue attempts"
on public.game_rescue_attempts
for delete
to authenticated
using (public.is_control_operator());

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
