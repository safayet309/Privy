# Privy — Supabase Private Messaging PWA

A GitHub Pages-friendly, single-page private messaging app using HTML, CSS, JavaScript and Supabase.

## Included
- Email/password sign-up and sign-in
- Username search and shareable `?u=username` invite links
- Two-person conversations and realtime message updates
- Photo upload (private Supabase Storage bucket, max 8 MB)
- Delete own message for everyone
- Delete conversation for both participants
- Read receipts, online presence, last-seen indicator, typing indicator
- Block user
- Installable PWA shell

## Setup
1. Create a Supabase project.
2. Open **SQL Editor**, create a new query, paste all of `supabase.sql`, and run it.
3. In Supabase **Project Settings → API** (or Connect), copy the Project URL and the **publishable key**. Older projects may show the `anon` key.
4. Open `app.js`. Replace:
   - `https://YOUR_PROJECT.supabase.co`
   - `YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY`
   Never use a `service_role` or secret key in the browser.
5. In Supabase **Authentication → URL Configuration**, add your GitHub Pages URL to Site URL / Redirect URLs, for example `https://YOUR-USERNAME.github.io/YOUR-REPO/`. For local testing you can use `http://localhost:8000`.
6. In **Authentication → Providers → Email**, configure whether email confirmation is required. If enabled, users must confirm before signing in.
7. Upload all files from this folder to the root of a GitHub repository. Enable **Settings → Pages → Deploy from a branch → main → /(root)**.
8. Visit the deployed URL. Register with a unique username. Have a second account sign up in a private/incognito browser to test both sides.
9. Serve locally over HTTP (PWA service workers do not work from `file://`): `python -m http.server 8000`, then open `http://localhost:8000`.

## Security notes
- The publishable/anon key is designed for browser use when RLS is enabled. A secret/service_role key bypasses RLS and must never be included in frontend code.
- All app tables have RLS. Storage bucket is private and access is membership-gated.
- Message deletion is enforced by RPC and only the sender can delete their own message.
- Deleting a conversation removes its database records for both users. The app attempts to remove uploaded photos first; if storage cleanup fails, orphaned photo objects may remain in the private bucket and should be cleaned up by an administrator.
- `last_seen` is visible to authenticated users because profiles are searchable. If you want last-seen privacy controls, add a dedicated RPC/view and narrower profile access.
- Online presence is best-effort. The app uses Supabase Realtime Presence, which is not a permanent online status database.
- A browser app cannot prevent screenshots or copies of already downloaded images.
- This is a practical starter project, not an audited end-to-end encrypted messenger. Messages and images are stored by your Supabase project and are not end-to-end encrypted.

## Current limitations
- Invite links target a username (`?u=username`) and open or create a direct conversation after sign-in. They are not expiring, one-time secret invitation tokens.
- The current UI lets users block accounts. A block prevents new chats and message inserts through the RLS policy, but does not automatically erase an existing conversation.
- If two users delete the same conversation at the same time, one may see a "conversation not found" message.
- For production, consider rate limits, abuse reporting, account deletion, image moderation, and server-side cleanup for storage objects.
