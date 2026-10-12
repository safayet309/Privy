-- PRIVY messaging schema — run once in Supabase SQL Editor.
-- Browser code uses only the publishable/anon key. Never expose service_role/secret keys.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null default 'User' check (char_length(display_name) between 1 and 50),
  avatar_url text,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower_idx on public.profiles(lower(username));

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key(conversation_id,user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members(user_id,deleted_at);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text check (body is null or char_length(body) <= 4000),
  photo_path text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  deleted_at timestamptz,
  constraint message_has_content check (nullif(trim(coalesce(body,'')),'') is not null or photo_path is not null)
);
create index if not exists messages_conversation_time_idx on public.messages(conversation_id,created_at);
create table if not exists public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(blocker_id,blocked_id),
  check (blocker_id <> blocked_id)
);

-- Keep updated_at useful for sorting conversations.
create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  update public.conversations set updated_at=now() where id=new.conversation_id;
  return new;
end $$;
drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation after insert on public.messages
for each row execute function public.touch_conversation();

-- Auth signup creates a profile. Username is taken from user metadata.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public as $$
declare chosen text;
begin
  chosen := lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)));
  chosen := regexp_replace(chosen, '[^a-z0-9_]', '_', 'g');
  chosen := left(chosen,24);
  if length(chosen)<3 then chosen := 'user_' || left(replace(new.id::text,'-',''),8); end if;
  if exists(select 1 from public.profiles where username=chosen) then
    chosen := left(chosen,15) || '_' || left(replace(new.id::text,'-',''),8);
  end if;
  insert into public.profiles(id,username,display_name)
  values(new.id,chosen,coalesce(nullif(new.raw_user_meta_data->>'display_name',''),chosen))
  on conflict(id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.blocks enable row level security;

-- SECURITY DEFINER membership helper avoids recursive RLS when a policy needs
-- to inspect conversation_members itself.
create or replace function public.is_active_member(_conversation_id uuid, _user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.conversation_members cm
    where cm.conversation_id=_conversation_id and cm.user_id=_user_id and cm.deleted_at is null)
$$;
revoke all on function public.is_active_member(uuid,uuid) from public;
grant execute on function public.is_active_member(uuid,uuid) to authenticated;

-- Profiles: signed-in users can find usernames; users edit only their own profile.
drop policy if exists "Profiles searchable by authenticated users" on public.profiles;
create policy "Profiles searchable by authenticated users" on public.profiles for select to authenticated using (true);
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile" on public.profiles for update to authenticated using (id=auth.uid()) with check (id=auth.uid());
drop policy if exists "Users insert own profile" on public.profiles;
create policy "Users insert own profile" on public.profiles for insert to authenticated with check (id=auth.uid());

-- A member can see a conversation only while their own membership is not deleted.
drop policy if exists "Members can read their conversations" on public.conversations;
create policy "Members can read their conversations" on public.conversations for select to authenticated using (public.is_active_member(id,auth.uid()));
drop policy if exists "Members can read memberships" on public.conversation_members;
create policy "Members can read memberships" on public.conversation_members for select to authenticated using (public.is_active_member(conversation_id,auth.uid()));
-- Membership rows are inserted only by the start_conversation security-definer RPC.
drop policy if exists "Members can read messages" on public.messages;
create policy "Members can read messages" on public.messages for select to authenticated using (
  deleted_at is null and public.is_active_member(messages.conversation_id,auth.uid())
);
drop policy if exists "Members can send messages" on public.messages;
create policy "Members can send messages" on public.messages for insert to authenticated with check (
  sender_id=auth.uid()
  and public.is_active_member(messages.conversation_id,auth.uid())
  and not exists(select 1 from public.conversation_members other join public.blocks b on
      (b.blocker_id=auth.uid() and b.blocked_id=other.user_id) or (b.blocker_id=other.user_id and b.blocked_id=auth.uid())
      where other.conversation_id=messages.conversation_id and other.user_id<>auth.uid())
);
-- No direct update/delete policies on messages; controlled RPCs enforce sender/member rules.

drop policy if exists "Users can view blocks they created" on public.blocks;
create policy "Users can view blocks they created" on public.blocks for select to authenticated using (blocker_id=auth.uid());
drop policy if exists "Users can create their own blocks" on public.blocks;
create policy "Users can create their own blocks" on public.blocks for insert to authenticated with check (blocker_id=auth.uid() and blocked_id<>auth.uid());
drop policy if exists "Users can remove their own blocks" on public.blocks;
create policy "Users can remove their own blocks" on public.blocks for delete to authenticated using (blocker_id=auth.uid());

-- Create or return a private two-person conversation; blocks prevent creating one.
create or replace function public.start_conversation(peer_user_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare me uuid := auth.uid(); existing_id uuid; new_id uuid;
begin
  if me is null then raise exception 'Sign in required'; end if;
  if peer_user_id is null or peer_user_id=me then raise exception 'Invalid user'; end if;
  if not exists(select 1 from public.profiles where id=peer_user_id) then raise exception 'User not found'; end if;
  if exists(select 1 from public.blocks where (blocker_id=me and blocked_id=peer_user_id) or (blocker_id=peer_user_id and blocked_id=me)) then raise exception 'This user is blocked'; end if;
  select a.conversation_id into existing_id
  from public.conversation_members a join public.conversation_members b on a.conversation_id=b.conversation_id
  where a.user_id=me and b.user_id=peer_user_id and a.deleted_at is null and b.deleted_at is null
  limit 1;
  if existing_id is not null then return existing_id; end if;
  insert into public.conversations(created_by) values(me) returning id into new_id;
  insert into public.conversation_members(conversation_id,user_id) values(new_id,me),(new_id,peer_user_id);
  return new_id;
end $$;

-- Delete a message for everyone; only the sender may do this.
create or replace function public.delete_message_everyone(target_message_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.messages m join public.conversation_members cm on cm.conversation_id=m.conversation_id
    where m.id=target_message_id and m.sender_id=auth.uid() and cm.user_id=auth.uid() and cm.deleted_at is null) then
    raise exception 'You can only delete your own message in an active conversation';
  end if;
  update public.messages set deleted_at=now(), body=null, photo_path=null where id=target_message_id;
end $$;

-- Delete the whole chat for both participants.
create or replace function public.delete_conversation_everyone(target_conversation_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.conversation_members where conversation_id=target_conversation_id and user_id=auth.uid() and deleted_at is null) then
    raise exception 'Conversation not found';
  end if;
  delete from public.conversations where id=target_conversation_id;
end $$;

-- Read receipt: only mark messages sent by the other member as read.
create or replace function public.mark_messages_read(target_conversation_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.conversation_members where conversation_id=target_conversation_id and user_id=auth.uid() and deleted_at is null) then
    raise exception 'Conversation not found';
  end if;
  update public.messages set read_at=now()
    where conversation_id=target_conversation_id and sender_id<>auth.uid() and read_at is null and deleted_at is null;
end $$;

revoke all on function public.start_conversation(uuid) from public;
revoke all on function public.delete_message_everyone(uuid) from public;
revoke all on function public.delete_conversation_everyone(uuid) from public;
revoke all on function public.mark_messages_read(uuid) from public;
grant execute on function public.start_conversation(uuid) to authenticated;
grant execute on function public.delete_message_everyone(uuid) to authenticated;
grant execute on function public.delete_conversation_everyone(uuid) to authenticated;
grant execute on function public.mark_messages_read(uuid) to authenticated;

-- Storage: private bucket, photos stored at <conversation UUID>/<sender UUID>/<file>.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('chat-photos','chat-photos',false,8388608,array['image/jpeg','image/png','image/webp','image/gif','image/avif'])
on conflict(id) do update set public=false,file_size_limit=8388608,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','image/avif'];

drop policy if exists "Chat members can read photos" on storage.objects;
create policy "Chat members can read photos" on storage.objects for select to authenticated using (
  bucket_id='chat-photos' and public.is_active_member((storage.foldername(name))[1]::uuid,auth.uid())
);
drop policy if exists "Chat members can upload photos" on storage.objects;
create policy "Chat members can upload photos" on storage.objects for insert to authenticated with check (
  bucket_id='chat-photos'
  and (storage.foldername(name))[2]=auth.uid()::text
  and public.is_active_member((storage.foldername(name))[1]::uuid,auth.uid())
);
drop policy if exists "Chat members can delete photos" on storage.objects;
create policy "Chat members can delete photos" on storage.objects for delete to authenticated using (
  bucket_id='chat-photos' and public.is_active_member((storage.foldername(name))[1]::uuid,auth.uid())
);

-- Realtime: enable row changes for the tables the app listens to.
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
when undefined_object then raise notice 'supabase_realtime publication not found; enable tables manually in Dashboard > Database > Publications.';
end $$;
do $$ begin
  alter publication supabase_realtime add table public.conversation_members;
exception when duplicate_object then null;
when undefined_object then raise notice 'Enable conversation_members in supabase_realtime publication if needed.';
end $$;

-- Optional: ensure API roles can access the app tables (RLS still controls rows).
grant usage on schema public to anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name,avatar_url,last_seen) on public.profiles to authenticated;
grant insert on public.profiles to authenticated;
grant select on public.conversations, public.conversation_members, public.messages to authenticated;
grant insert on public.messages to authenticated;
grant select,insert,delete on public.blocks to authenticated;

-- ===== added later (username check + unread index) =====
-- Signup used to silently rename you if the username was taken (the trigger appends random chars).
-- This lets the sign-up form check availability *before* creating the account.
create or replace function public.username_available(name text)
returns boolean language sql stable security definer set search_path=public as $$
  select not exists(select 1 from public.profiles where lower(username)=lower(name))
$$;
revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- Faster unread counts / latest-message lookups.
create index if not exists messages_unread_idx on public.messages(conversation_id, sender_id) where read_at is null and deleted_at is null;
