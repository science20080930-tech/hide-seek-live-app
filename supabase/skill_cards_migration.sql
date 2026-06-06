alter table public.game_rooms
  add column if not exists pause_all_until timestamptz,
  add column if not exists pause_all_except_user_id uuid references auth.users(id) on delete set null,
  add column if not exists pause_green_until timestamptz,
  add column if not exists pause_red_until timestamptz,
  add column if not exists hide_green_until timestamptz,
  add column if not exists skill_event_kind text,
  add column if not exists skill_event_message text,
  add column if not exists skill_event_actor_id uuid references auth.users(id) on delete set null,
  add column if not exists skill_event_at timestamptz;

alter table public.game_players
  add column if not exists skill_card text,
  add column if not exists skill_card_awarded_at timestamptz,
  add column if not exists skill_immune_until timestamptz;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'game_players_skill_card_check'
      and conrelid = 'public.game_players'::regclass
  ) then
    alter table public.game_players drop constraint game_players_skill_card_check;
  end if;
end $$;

alter table public.game_players
  add constraint game_players_skill_card_check
  check (
    skill_card is null
    or skill_card in (
      'red_pause_all_5',
      'red_pause_green_3',
      'green_hide_green_3',
      'green_immune_30',
      'green_pause_red_3'
    )
  );

create or replace function public.skill_card_label(p_card text)
returns text
language sql
immutable
as $$
  select case p_card
    when 'red_pause_all_5' then '全體暫停 5 秒'
    when 'red_pause_green_3' then '綠隊暫停 3 秒'
    when 'red_bomb_pause_red_3' then '炸彈：紅隊暫停 3 秒'
    when 'green_hide_green_3' then '隱藏綠隊行蹤 3 秒'
    when 'green_immune_30' then '無敵 30 秒'
    when 'green_pause_red_3' then '紅隊暫停 3 秒'
    else '未知技能卡'
  end;
$$;

revoke all on function public.skill_card_label(text) from public;
grant execute on function public.skill_card_label(text) to authenticated;

create or replace function public.random_skill_card(p_team text)
returns text
language plpgsql
volatile
as $$
declare
  pick integer := floor(random() * 3)::integer;
begin
  if p_team = 'red' then
    if pick = 0 then return 'red_pause_all_5'; end if;
    if pick = 1 then return 'red_pause_green_3'; end if;
    return 'red_bomb_pause_red_3';
  end if;

  if p_team = 'green' then
    if pick = 0 then return 'green_hide_green_3'; end if;
    if pick = 1 then return 'green_immune_30'; end if;
    return 'green_pause_red_3';
  end if;

  return null;
end;
$$;

revoke all on function public.random_skill_card(text) from public;
grant execute on function public.random_skill_card(text) to authenticated;

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
  first_rescuer public.game_players%rowtype;
  room_state public.game_rooms%rowtype;
  other_attempt public.game_rescue_attempts%rowtype;
  normalized_code text;
  new_code text;
  new_red_score integer;
  awarded_card text;
  event_message text;
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

  select *
    into room_state
  from public.game_rooms
  where room_code = p_room_code
  for update;

  if not found or room_state.status <> 'started' then
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

    new_red_score := coalesce(room_state.red_score, 0) + 1;
    awarded_card := null;
    event_message := null;

    if new_red_score % 5 = 0 then
      awarded_card := public.random_skill_card('red');
      if awarded_card = 'red_bomb_pause_red_3' then
        event_message := coalesce(actor.display_name, '紅隊玩家') || ' 抽到炸彈，紅隊暫停 3 秒！';
        update public.game_rooms
          set red_score = new_red_score,
              pause_red_until = now() + make_interval(secs => 3),
              skill_event_kind = awarded_card,
              skill_event_message = event_message,
              skill_event_actor_id = actor.user_id,
              skill_event_at = now(),
              updated_at = now()
        where room_code = p_room_code;
      else
        update public.game_players
          set skill_card = awarded_card,
              skill_card_awarded_at = now(),
              updated_at = now()
        where user_id = actor.user_id;

        event_message := coalesce(actor.display_name, '紅隊玩家') || ' 獲得技能卡：' || public.skill_card_label(awarded_card);
        update public.game_rooms
          set red_score = new_red_score,
              skill_event_kind = 'skill_awarded',
              skill_event_message = event_message,
              skill_event_actor_id = actor.user_id,
              skill_event_at = now(),
              updated_at = now()
        where room_code = p_room_code;
      end if;
    else
      update public.game_rooms
        set red_score = new_red_score,
            updated_at = now()
      where room_code = p_room_code;
    end if;

    delete from public.game_rescue_attempts
    where room_code = p_room_code
      and target_user_id = target.user_id;

    return jsonb_build_object(
      'ok', true,
      'type', 'capture_success',
      'message', coalesce(event_message, 'Capture success.'),
      'target_user_id', target.user_id,
      'target_name', target.display_name,
      'rescue_code', new_code,
      'skill_card', awarded_card
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

      select *
        into first_rescuer
      from public.game_players
      where user_id = other_attempt.rescuer_id
      for update;

      awarded_card := public.random_skill_card('green');
      update public.game_players
        set skill_card = awarded_card,
            skill_card_awarded_at = now(),
            updated_at = now()
      where user_id = other_attempt.rescuer_id;

      event_message := coalesce(first_rescuer.display_name, '綠隊玩家') || ' 救援成功並獲得技能卡：' || public.skill_card_label(awarded_card);
      update public.game_rooms
        set skill_event_kind = 'skill_awarded',
            skill_event_message = event_message,
            skill_event_actor_id = other_attempt.rescuer_id,
            skill_event_at = now(),
            updated_at = now()
      where room_code = p_room_code;

      delete from public.game_rescue_attempts
      where room_code = p_room_code
        and target_user_id = target.user_id;

      return jsonb_build_object(
        'ok', true,
        'type', 'rescue_success',
        'message', event_message,
        'target_user_id', target.user_id,
        'target_name', target.display_name,
        'capture_code', new_code,
        'skill_card', awarded_card,
        'skill_awarded_to', other_attempt.rescuer_id
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

create or replace function public.use_skill_card(p_room_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor public.game_players%rowtype;
  room_state public.game_rooms%rowtype;
  card text;
  event_message text;
begin
  select *
    into actor
  from public.game_players
  where user_id = auth.uid()
    and room_code = p_room_code
  for update;

  if not found or actor.team is null then
    return jsonb_build_object('ok', false, 'type', 'not_joined', 'message', 'You are not in this game room.');
  end if;

  select *
    into room_state
  from public.game_rooms
  where room_code = p_room_code
  for update;

  if not found or room_state.status <> 'started' then
    return jsonb_build_object('ok', false, 'type', 'not_started', 'message', 'Game has not started.');
  end if;

  card := actor.skill_card;
  if card is null then
    return jsonb_build_object('ok', false, 'type', 'no_card', 'message', 'No skill card is available.');
  end if;

  if actor.team = 'red' and card not in ('red_pause_all_5', 'red_pause_green_3') then
    return jsonb_build_object('ok', false, 'type', 'invalid_card', 'message', 'Invalid red team skill card.');
  end if;

  if actor.team = 'green' and card not in ('green_hide_green_3', 'green_immune_30', 'green_pause_red_3') then
    return jsonb_build_object('ok', false, 'type', 'invalid_card', 'message', 'Invalid green team skill card.');
  end if;

  event_message := coalesce(actor.display_name, '玩家') || ' 使用技能卡：' || public.skill_card_label(card);

  update public.game_players
    set skill_card = null,
        skill_card_awarded_at = null,
        updated_at = now()
  where user_id = actor.user_id;

  if card = 'red_pause_all_5' then
    update public.game_rooms
      set pause_all_until = now() + make_interval(secs => 5),
          pause_all_except_user_id = actor.user_id,
          skill_event_kind = card,
          skill_event_message = event_message,
          skill_event_actor_id = actor.user_id,
          skill_event_at = now(),
          updated_at = now()
    where room_code = p_room_code;
  elsif card = 'red_pause_green_3' then
    update public.game_rooms
      set pause_green_until = now() + make_interval(secs => 3),
          skill_event_kind = card,
          skill_event_message = event_message,
          skill_event_actor_id = actor.user_id,
          skill_event_at = now(),
          updated_at = now()
    where room_code = p_room_code;
  elsif card = 'green_hide_green_3' then
    update public.game_rooms
      set hide_green_until = now() + make_interval(secs => 3),
          skill_event_kind = card,
          skill_event_message = event_message,
          skill_event_actor_id = actor.user_id,
          skill_event_at = now(),
          updated_at = now()
    where room_code = p_room_code;
  elsif card = 'green_immune_30' then
    update public.game_players
      set skill_immune_until = now() + make_interval(secs => 30),
          updated_at = now()
    where user_id = actor.user_id;

    update public.game_rooms
      set skill_event_kind = card,
          skill_event_message = event_message,
          skill_event_actor_id = actor.user_id,
          skill_event_at = now(),
          updated_at = now()
    where room_code = p_room_code;
  elsif card = 'green_pause_red_3' then
    update public.game_rooms
      set pause_red_until = now() + make_interval(secs => 3),
          skill_event_kind = card,
          skill_event_message = event_message,
          skill_event_actor_id = actor.user_id,
          skill_event_at = now(),
          updated_at = now()
    where room_code = p_room_code;
  end if;

  return jsonb_build_object('ok', true, 'type', 'skill_used', 'card', card, 'message', event_message);
end;
$$;

revoke all on function public.use_skill_card(text) from public;
grant execute on function public.use_skill_card(text) to authenticated;
