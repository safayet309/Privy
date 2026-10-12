-- Run ONCE in Supabase SQL Editor if you already ran supabase.sql earlier.
-- (Fresh installs: these are already appended at the bottom of supabase.sql.)

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
