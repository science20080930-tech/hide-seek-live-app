create table if not exists public.game_players (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null,
  team text not null check (team in ('red', 'green')),
  room_code text not null default 'main',
  lat double precision,
  lng double precision,
  accuracy integer,
  is_online boolean not null default true,
  updated_at timestamptz not null default now()
);

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
alter table public.player_profiles enable row level security;
alter table public.control_operators enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.game_players to authenticated;
grant select, insert, update, delete on public.player_profiles to authenticated;
grant select on public.control_operators to authenticated;

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

drop policy if exists "Operators can read own operator row" on public.control_operators;
create policy "Operators can read own operator row"
on public.control_operators
for select
to authenticated
using (user_id = auth.uid());

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
    where viewer.user_id = auth.uid()
      and viewer.room_code = target_room
      and (
        viewer.team <> target_team
      )
  );
$$;

revoke all on function public.can_view_game_player(text, text) from public;
grant execute on function public.can_view_game_player(text, text) to authenticated;

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
with check (user_id = auth.uid());

drop policy if exists "Players can update their own row" on public.game_players;
create policy "Players can update their own row"
on public.game_players
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

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
