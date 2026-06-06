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

drop policy if exists "Players can update their own row" on public.game_players;
create policy "Players can update their own row"
on public.game_players
for update
to authenticated
using (user_id = auth.uid())
with check (public.can_update_own_player_row(user_id, room_code, team));

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
