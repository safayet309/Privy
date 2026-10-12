/* Privy PWA — configure the Supabase URL and publishable/anon key below.
   Never place a Supabase secret or service_role key in browser code. */
(() => {
  "use strict";
  const SUPABASE_URL = "https://pteplvsseiwlvqmbhcpu.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_kXRnQzKRdGQvUKLi1apFuA_qndnI41v";
  const BUCKET = "chat-photos";
  const $ = (id) => document.getElementById(id);
  const state = {
    client: null, user: null, profile: null, signup: false,
    chats: [], active: null, messages: [], peer: null, selectedPhoto: null,
    channel: null, presenceChannel: null, listChannel: null,
    online: new Set(), blocked: new Map(),
    peerTypingTimer: null, myTypingTimer: null, lastTypingSent: 0,
    modalResolve: null, searchTimer: null, searchSeq: 0, lastSeenTimer: null,
    refreshTimer: null, refreshSeq: 0, loadSeq: 0, renderSeq: 0,
    urlCache: new Map(), forceBottom: false
  };
  const appShell = document.querySelector(".app-shell");

  /* ---------- PWA: register early, independent of auth/config ---------- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.warn));
  }

  /* ---------- helpers ---------- */
  function toast(message) { const el = $("toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 3200); }
  function show(el, yes = true) { el.classList.toggle("hidden", !yes); }
  function esc(s = "") { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function initials(name = "User") { return name.trim().slice(0, 1).toUpperCase() || "?"; }
  function avatarHTML(profile, extra = "") { const name = profile?.display_name || profile?.username || "User"; return `<div class="avatar ${extra}">${profile?.avatar_url ? `<img alt="" src="${esc(profile.avatar_url)}">` : esc(initials(name))}</div>`; }
  function setAvatar(el, profile) { el.innerHTML = profile?.avatar_url ? `<img alt="" src="${esc(profile.avatar_url)}">` : esc(initials(profile?.display_name || profile?.username || "User")); }
  function niceTime(value) { if (!value) return ""; const d = new Date(value), now = new Date(); if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); return d.toLocaleDateString([], { month: "short", day: "numeric" }); }
  function dayLabel(value) {
    const d = new Date(value), now = new Date(), y = new Date(); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return "TODAY";
    if (d.toDateString() === y.toDateString()) return "YESTERDAY";
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }).toUpperCase();
  }
  function errorText(error) { return error?.message || "Something went wrong. Please try again."; }
  function isConfigured() { return !(SUPABASE_URL.includes("YOUR_PROJECT") || SUPABASE_PUBLISHABLE_KEY.includes("YOUR_")); }
  function ensureConfigured() {
    if (!window.supabase) { toast("Could not load Supabase library. Check your internet connection."); return false; }
    if (!isConfigured()) { toast("First add your Supabase URL and publishable key in app.js."); return false; }
    return true;
  }
  function modal(title, text, confirm = "Confirm", danger = false) {
    $("modalTitle").textContent = title; $("modalText").textContent = text; $("modalConfirm").textContent = confirm; $("modalConfirm").classList.toggle("danger-text", danger);
    show($("modalBackdrop")); return new Promise((resolve) => (state.modalResolve = resolve));
  }
  $("modalCancel").onclick = () => { show($("modalBackdrop"), false); state.modalResolve?.(false); };
  $("modalConfirm").onclick = () => { show($("modalBackdrop"), false); state.modalResolve?.(true); };
  $("modalBackdrop").addEventListener("click", (e) => { if (e.target === $("modalBackdrop")) $("modalCancel").click(); });

  /* ---------- auth ---------- */
  function authMode(signup) {
    state.signup = signup;
    $("authTitle").textContent = signup ? "Create your account." : "Welcome back.";
    $("authSubtitle").textContent = signup ? "A username helps friends find you." : "Sign in to continue your conversations.";
    $("authSubmit").innerHTML = signup ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
    $("switchText").textContent = signup ? "Already have an account?" : "New to Privy?";
    $("authSwitch").textContent = signup ? "Sign in" : "Create account";
    show($("usernameLabel"), signup); $("authUsername").required = signup;
    $("authPassword").autocomplete = signup ? "new-password" : "current-password";
  }
  $("authSwitch").onclick = () => authMode(!state.signup);
  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault(); if (!ensureConfigured()) return;
    const email = $("authEmail").value.trim(), password = $("authPassword").value, username = $("authUsername").value.trim().toLowerCase();
    const btn = $("authSubmit"); btn.disabled = true;
    try {
      if (state.signup) {
        if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error("Username must be 3–24 characters: letters, numbers or underscore.");
        const { data: free, error: availErr } = await state.client.rpc("username_available", { name: username });
        if (!availErr && free === false) throw new Error("That username is already taken.");
        const { data, error } = await state.client.auth.signUp({ email, password, options: { data: { username, display_name: username }, emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (data.session) { state.user = data.user; await enterApp(); }
        else toast("Account created. Check your email to confirm, then sign in.");
      } else {
        const { data, error } = await state.client.auth.signInWithPassword({ email, password }); if (error) throw error;
        state.user = data.user; await enterApp();
      }
    } catch (err) { toast(errorText(err)); } finally { btn.disabled = false; }
  });
  async function ensureProfile(usernameHint) {
    const { data: existing, error } = await state.client.from("profiles").select("*").eq("id", state.user.id).maybeSingle();
    if (error) throw error;
    if (existing) { state.profile = existing; return existing; }
    const meta = state.user.user_metadata || {};
    const username = (usernameHint || meta.username || state.user.email.split("@")[0]).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24);
    const row = { id: state.user.id, username, display_name: meta.display_name || username };
    const { data, error: insertError } = await state.client.from("profiles").insert(row).select().single();
    if (insertError) throw insertError; state.profile = data; return data;
  }
  async function enterApp() {
    try { await ensureProfile(); } catch (e) { toast("Profile setup failed: " + errorText(e)); return; }
    appShell.classList.remove("signed-out");
    show($("authView"), false); show($("welcomeView"), true); show($("chatView"), false);
    $("myName").textContent = state.profile.display_name || state.profile.username; $("myEmail").textContent = "@" + state.profile.username; setAvatar($("myAvatar"), state.profile);
    await loadBlocks(); await refreshChats(); await setupPresence(); await setupRealtime(); startLastSeen();
    const params = new URLSearchParams(location.search), invite = params.get("u");
    if (invite) { history.replaceState({}, "", location.pathname); await openUsername(invite); }
  }
  async function teardown() {
    clearInterval(state.lastSeenTimer); clearTimeout(state.refreshTimer);
    for (const k of ["channel", "presenceChannel", "listChannel"]) {
      if (state[k]) { try { await state.client.removeChannel(state[k]); } catch (_) {} state[k] = null; }
    }
    state.user = null; state.profile = null; state.active = null; state.peer = null; state.chats = []; state.messages = []; state.blocked = new Map(); state.online = new Set(); state.urlCache.clear();
    appShell.classList.remove("chat-open"); appShell.classList.add("signed-out");
    show($("chatView"), false); show($("welcomeView"), false); show($("authView"), true); authMode(false); renderChats();
  }
  async function signOut() { try { await state.client.auth.signOut(); } catch (_) {} await teardown(); }
  $("signOutBtn").onclick = signOut;

  /* ---------- blocks ---------- */
  async function loadBlocks() {
    const { data } = await state.client.from("blocks").select("blocked_id").eq("blocker_id", state.user.id);
    state.blocked = new Map((data || []).map((r) => [r.blocked_id, true]));
  }
  async function isBlocked(userId) {
    const { data } = await state.client.from("blocks").select("blocker_id,blocked_id").or(`and(blocker_id.eq.${state.user.id},blocked_id.eq.${userId}),and(blocker_id.eq.${userId},blocked_id.eq.${state.user.id})`).limit(1);
    return !!data?.length;
  }

  /* ---------- chat list ---------- */
  function scheduleRefresh() { clearTimeout(state.refreshTimer); state.refreshTimer = setTimeout(refreshChats, 200); }
  async function refreshChats() {
    if (!state.user) return;
    const seq = ++state.refreshSeq;
    const { data: members, error } = await state.client.from("conversation_members").select("conversation_id, conversations(id,created_at,updated_at)").eq("user_id", state.user.id).is("deleted_at", null);
    if (error) { console.error(error); toast("Could not load conversations: " + error.message); return; }
    const ids = (members || []).map((x) => x.conversation_id);
    if (!ids.length) { if (seq === state.refreshSeq) { state.chats = []; renderChats(); checkActiveStillExists(); } return; }
    const [othersRes, perChat] = await Promise.all([
      state.client.from("conversation_members").select("conversation_id,user_id,profiles(id,username,display_name,avatar_url,last_seen)").in("conversation_id", ids).neq("user_id", state.user.id).is("deleted_at", null),
      Promise.all(ids.map(async (id) => {
        const [last, unread] = await Promise.all([
          state.client.from("messages").select("conversation_id,body,photo_path,created_at,sender_id").eq("conversation_id", id).is("deleted_at", null).order("created_at", { ascending: false }).limit(1),
          state.client.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", id).neq("sender_id", state.user.id).is("read_at", null).is("deleted_at", null)
        ]);
        return { id, last: last.data?.[0] || null, unread: unread.count || 0 };
      }))
    ]);
    if (seq !== state.refreshSeq) return; // a newer refresh is in flight
    if (othersRes.error) { console.error(othersRes.error); return; }
    const others = othersRes.data || [];
    state.chats = ids.map((id) => {
      const member = members.find((m) => m.conversation_id === id), other = others.find((m) => m.conversation_id === id), extra = perChat.find((p) => p.id === id);
      return { id, created_at: member?.conversations?.created_at, updated_at: member?.conversations?.updated_at, peer: other?.profiles || null, last: extra?.last || null, unread: id === state.active ? 0 : (extra?.unread || 0) };
    }).filter((c) => c.peer).sort((a, b) => new Date(b.last?.created_at || b.updated_at || b.created_at) - new Date(a.last?.created_at || a.updated_at || a.created_at));
    if (state.active) { const c = state.chats.find((x) => x.id === state.active); if (c) { state.peer = c.peer; updatePeerStatus(); } }
    renderChats(); checkActiveStillExists();
  }
  function checkActiveStillExists() {
    if (state.active && !state.chats.some((c) => c.id === state.active)) closeChat("This conversation is no longer available.");
  }
  function closeChat(message) {
    if (state.channel) { state.client.removeChannel(state.channel); state.channel = null; }
    state.active = null; state.peer = null; state.messages = [];
    show($("chatView"), false); show($("welcomeView"), true); appShell.classList.remove("chat-open");
    if (message) toast(message);
  }
  function renderChats() {
    const root = $("chatList");
    if (!state.chats.length) { root.innerHTML = '<div class="empty-side">No conversations yet.<br>Search for a username to start one.</div>'; return; }
    root.innerHTML = state.chats.map((c) => {
      const online = state.online.has(c.peer.id);
      const preview = c.last ? ((c.last.sender_id === state.user.id ? "You: " : "") + (c.last.photo_path ? "▧ Photo" : esc(c.last.body || ""))) : "Start a conversation";
      return `<button class="chat-item ${state.active === c.id ? "active" : ""}" data-chat="${c.id}"><div class="av-wrap">${avatarHTML(c.peer)}${online ? '<span class="online-dot" title="Online"></span>' : ""}</div><div class="chat-item-copy"><div class="chat-item-top"><strong>${esc(c.peer.display_name || c.peer.username)}</strong><span class="chat-time">${niceTime(c.last?.created_at || c.updated_at)}</span></div><div class="chat-item-bottom"><span class="chat-preview ${c.unread ? "unread" : ""}">${preview}</span>${c.unread ? `<span class="unread-badge">${c.unread > 99 ? "99+" : c.unread}</span>` : ""}</div></div></button>`;
    }).join("");
    root.querySelectorAll("[data-chat]").forEach((b) => (b.onclick = () => openChat(b.dataset.chat)));
  }

  /* ---------- search (FIXED: isBlocked is async, so the old filter dropped every result) ---------- */
  $("userSearch").addEventListener("input", () => {
    clearTimeout(state.searchTimer); const q = $("userSearch").value.trim().replace(/^@/, "");
    if (q.length < 2) { show($("searchResults"), false); return; }
    state.searchTimer = setTimeout(() => searchUsers(q), 250);
  });
  async function searchUsers(q) {
    const clean = q.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (clean.length < 2) { $("searchResults").innerHTML = '<div class="empty-side">Usernames use letters, numbers and underscores.</div>'; show($("searchResults")); return; }
    const seq = ++state.searchSeq;
    const pattern = "%" + clean.replace(/_/g, "\\_") + "%"; // escape "_" (a wildcard in LIKE)
    const { data, error } = await state.client.from("profiles").select("id,username,display_name,avatar_url,last_seen").ilike("username", pattern).neq("id", state.user.id).limit(20);
    if (seq !== state.searchSeq) return; // stale response
    if (error) { toast(errorText(error)); return; }
    const results = (data || []).sort((a, b) => (b.username.startsWith(clean) - a.username.startsWith(clean)) || a.username.localeCompare(b.username)).slice(0, 12);
    $("searchResults").innerHTML = results.length ? results.map((p) => {
      const blocked = state.blocked.has(p.id);
      return `<button class="search-result" ${blocked ? `data-unblock="${p.id}"` : `data-user="${p.id}"`}>${avatarHTML(p)}<div><span>${esc(p.display_name || p.username)}</span><small>${blocked ? "Blocked · tap to unblock" : "@" + esc(p.username)}</small></div></button>`;
    }).join("") : '<div class="empty-side">No matching usernames found.</div>';
    show($("searchResults"));
    $("searchResults").querySelectorAll("[data-user]").forEach((b) => (b.onclick = () => startChat(b.dataset.user)));
    $("searchResults").querySelectorAll("[data-unblock]").forEach((b) => (b.onclick = () => unblock(b.dataset.unblock)));
  }
  async function unblock(id) {
    const yes = await modal("Unblock this user?", "They will be able to start a conversation with you again.", "Unblock"); if (!yes) return;
    const { error } = await state.client.from("blocks").delete().eq("blocker_id", state.user.id).eq("blocked_id", id);
    if (error) return toast(errorText(error));
    state.blocked.delete(id); toast("User unblocked."); show($("searchResults"), false); $("userSearch").value = "";
  }
  async function openUsername(username) {
    const { data, error } = await state.client.from("profiles").select("id").eq("username", username.toLowerCase()).maybeSingle();
    if (error || !data) { toast("That invite username was not found."); return; } await startChat(data.id);
  }
  async function startChat(peerId) {
    if (peerId === state.user.id) return toast("You cannot start a chat with yourself.");
    if (await isBlocked(peerId)) return toast("This chat is unavailable because one of you has blocked the other.");
    const { data, error } = await state.client.rpc("start_conversation", { peer_user_id: peerId });
    if (error) { toast(errorText(error)); return; }
    $("userSearch").value = ""; show($("searchResults"), false); await refreshChats(); await openChat(data);
  }

  /* ---------- conversation ---------- */
  async function openChat(id) {
    if (!state.chats.find((c) => c.id === id)) await refreshChats();
    const chosen = state.chats.find((c) => c.id === id); if (!chosen) return;
    if (state.channel) { await state.client.removeChannel(state.channel); state.channel = null; }
    state.active = id; state.peer = chosen.peer; state.messages = []; state.forceBottom = true; chosen.unread = 0; renderChats();
    $("peerName").textContent = chosen.peer.display_name || chosen.peer.username; setAvatar($("peerAvatar"), chosen.peer);
    show($("typingLine"), false); updatePeerStatus(); show($("welcomeView"), false); show($("chatView"), true); appShell.classList.add("chat-open"); show($("chatMenu"), false);
    state.channel = state.client.channel("chat:" + id);
    state.channel.on("broadcast", { event: "typing" }, (payload) => {
      if (payload.payload?.user_id === state.user.id) return;
      show($("typingLine"), !!payload.payload?.typing);
      clearTimeout(state.peerTypingTimer); state.peerTypingTimer = setTimeout(() => show($("typingLine"), false), 2500);
    }).subscribe();
    await loadMessages();
  }
  async function loadMessages() {
    if (!state.active) return;
    const id = state.active, seq = ++state.loadSeq;
    // newest 300, then reversed (the old ascending+limit(500) hid the NEWEST messages once a chat grew past 500)
    const { data, error } = await state.client.from("messages").select("*").eq("conversation_id", id).is("deleted_at", null).order("created_at", { ascending: false }).limit(300);
    if (error) { toast("Could not load messages: " + errorText(error)); return; }
    if (seq !== state.loadSeq || id !== state.active) return;
    state.messages = (data || []).reverse(); await renderMessages();
    if (state.messages.some((m) => m.sender_id !== state.user.id && !m.read_at)) markRead();
  }
  async function signedUrl(path) {
    const hit = state.urlCache.get(path); if (hit && hit.exp > Date.now() + 60000) return hit.url;
    const { data } = await state.client.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (data?.signedUrl) { state.urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 3600 * 1000 }); return data.signedUrl; }
    return null;
  }
  async function renderMessages() {
    const area = $("messageArea"), seq = ++state.renderSeq, snapshot = state.messages;
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
    if (!snapshot.length) { area.innerHTML = '<div class="message-empty"><b>It starts with a hello.</b>Send a message or share a photo to get things going.</div>'; return; }
    const urls = await Promise.all(snapshot.map((m) => (m.photo_path ? signedUrl(m.photo_path) : null))); // parallel, cached
    if (seq !== state.renderSeq) return;
    const rows = []; let lastDay = "";
    snapshot.forEach((m, i) => {
      const day = new Date(m.created_at).toDateString();
      if (day !== lastDay) { rows.push(`<div class="day-label"><span>${esc(dayLabel(m.created_at))}</span></div>`); lastDay = day; }
      let photo = "";
      if (m.photo_path) photo = urls[i] ? `<img class="message-photo" src="${esc(urls[i])}" alt="Shared photo" loading="lazy" data-photo="${esc(urls[i])}">` : '<div class="muted">Photo unavailable</div>';
      const mine = m.sender_id === state.user.id, time = niceTime(m.created_at);
      rows.push(`<div class="message-row ${mine ? "mine" : ""}" data-message="${m.id}"><div class="message-bubble">${photo}${m.body ? esc(m.body) : ""}<span class="message-time">${time}${mine ? (m.read_at ? " · Seen" : " · Sent") : ""}</span></div>${mine ? `<div class="message-actions"><button class="mini-btn" data-delete="${m.id}" title="Delete message for everyone">Delete</button></div>` : ""}</div>`);
    });
    area.innerHTML = rows.join("");
    area.querySelectorAll("[data-delete]").forEach((b) => (b.onclick = () => deleteMessage(b.dataset.delete)));
    area.querySelectorAll("[data-photo]").forEach((img) => (img.onclick = () => window.open(img.dataset.photo, "_blank", "noopener")));
    if (nearBottom || state.forceBottom) { area.scrollTop = area.scrollHeight; state.forceBottom = false; }
  }
  async function markRead() {
    if (!state.active || document.visibilityState !== "visible") return;
    const { error } = await state.client.rpc("mark_messages_read", { target_conversation_id: state.active });
    if (error) console.warn("Read receipt:", error.message); else scheduleRefresh();
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { markRead(); pingLastSeen(); } });

  /* ---------- sending ---------- */
  async function prepareImage(file) {
    // Resize/compress to JPEG (max 1600px). Falls back to the original file if the browser can't decode it.
    if (file.type === "image/gif") return file;
    try {
      const bmp = await createImageBitmap(file); const max = 1600, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas"); canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.86));
      if (blob && (blob.size < file.size || !/^image\/(jpeg|png|webp|avif)$/.test(file.type))) return new File([blob], "photo.jpg", { type: "image/jpeg" });
    } catch (e) { console.warn("Image prepare skipped", e); }
    return file;
  }
  async function sendMessage() {
    const body = $("messageInput").value.trim(); let file = state.selectedPhoto;
    if (!body && !file) return;
    if (!state.active) return toast("Choose a conversation first.");
    if (body.length > 4000) return toast("Message is too long.");
    $("sendBtn").disabled = true;
    try {
      let photo_path = null;
      if (file) {
        if (!file.type.startsWith("image/")) throw new Error("Please select an image.");
        file = await prepareImage(file);
        if (file.size > 8 * 1024 * 1024) throw new Error("Images must be 8 MB or smaller.");
        const ext = (file.type.split("/")[1] || "jpg").replace(/[^a-z0-9]/g, "") || "jpg";
        photo_path = `${state.active}/${state.user.id}/${crypto.randomUUID()}.${ext}`;
        const { error } = await state.client.storage.from(BUCKET).upload(photo_path, file, { contentType: file.type, upsert: false, cacheControl: "3600" });
        if (error) throw error;
      }
      const { error } = await state.client.from("messages").insert({ conversation_id: state.active, sender_id: state.user.id, body: body || null, photo_path });
      if (error) { if (photo_path) await state.client.storage.from(BUCKET).remove([photo_path]); throw error; }
      $("messageInput").value = ""; $("messageInput").style.height = "auto"; clearPhoto(); state.forceBottom = true; await loadMessages(); scheduleRefresh();
    } catch (e) { toast(errorText(e)); } finally { $("sendBtn").disabled = false; $("messageInput").focus(); }
  }
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
  const desktopKeyboard = window.matchMedia("(hover:hover) and (pointer:fine)");
  $("messageInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && desktopKeyboard.matches) { e.preventDefault(); sendMessage(); } });
  $("messageInput").addEventListener("input", () => {
    const el = $("messageInput"); el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 130) + "px";
    if (!state.channel) return;
    const now = Date.now();
    if (now - state.lastTypingSent > 1500) { state.lastTypingSent = now; state.channel.send({ type: "broadcast", event: "typing", payload: { user_id: state.user.id, typing: true } }); } // throttled (was: every keystroke)
    clearTimeout(state.myTypingTimer);
    state.myTypingTimer = setTimeout(() => { state.lastTypingSent = 0; state.channel?.send({ type: "broadcast", event: "typing", payload: { user_id: state.user.id, typing: false } }); }, 1600);
  });
  $("attachBtn").onclick = () => $("photoInput").click();
  $("photoInput").onchange = () => {
    const f = $("photoInput").files?.[0]; if (!f) return;
    if (!f.type.startsWith("image/")) return toast("Choose an image file.");
    if (f.size > 25 * 1024 * 1024) { $("photoInput").value = ""; return toast("That image is too large."); }
    state.selectedPhoto = f; $("photoPreview").innerHTML = `<img src="${URL.createObjectURL(f)}" alt="Photo preview"><button type="button" id="removePhoto" aria-label="Remove photo">×</button>`;
    show($("photoPreview")); $("removePhoto").onclick = clearPhoto;
  };
  function clearPhoto() { state.selectedPhoto = null; $("photoInput").value = ""; $("photoPreview").innerHTML = ""; show($("photoPreview"), false); }

  /* ---------- delete / block ---------- */
  async function deleteMessage(id) {
    const yes = await modal("Delete this message?", "It will be removed from this conversation for both people. This cannot be undone.", "Delete", true); if (!yes) return;
    const msg = state.messages.find((m) => m.id === id); if (!msg || msg.sender_id !== state.user.id) return toast("You can only delete your own messages.");
    const { error } = await state.client.rpc("delete_message_everyone", { target_message_id: id });
    if (error) { toast(errorText(error)); return; }
    if (msg.photo_path) await state.client.storage.from(BUCKET).remove([msg.photo_path]);
    await loadMessages(); scheduleRefresh(); toast("Message deleted for everyone.");
  }
  async function deleteChat() {
    if (!state.active) return;
    const yes = await modal("Delete chat for both?", "This permanently removes the conversation and its messages from both users' chat lists. This cannot be undone.", "Delete chat", true); if (!yes) return;
    const id = state.active;
    try { // best-effort photo cleanup before the DB rows are removed
      const { data: files } = await state.client.storage.from(BUCKET).list(id, { limit: 1000 });
      for (const folder of (files || []).filter((f) => !f.id)) {
        const { data: inside } = await state.client.storage.from(BUCKET).list(id + "/" + folder.name, { limit: 1000 });
        const paths = (inside || []).map((f) => id + "/" + folder.name + "/" + f.name); if (paths.length) await state.client.storage.from(BUCKET).remove(paths);
      }
    } catch (e) { console.warn("Photo cleanup incomplete", e); }
    const { error } = await state.client.rpc("delete_conversation_everyone", { target_conversation_id: id });
    if (error) { toast(errorText(error)); return; }
    closeChat(); await refreshChats(); toast("Conversation deleted for both users.");
  }
  $("chatMenuBtn").onclick = () => show($("chatMenu"));
  $("deleteChatBtn").onclick = () => { show($("chatMenu"), false); deleteChat(); };
  $("blockBtn").onclick = async () => {
    show($("chatMenu"), false); if (!state.peer) return;
    const peerId = state.peer.id;
    const yes = await modal("Block this user?", "They won't be able to message you or start a conversation while the block is active. You can unblock them later by searching their username.", "Block user", true); if (!yes) return;
    const { error } = await state.client.from("blocks").insert({ blocker_id: state.user.id, blocked_id: peerId });
    if (error && error.code !== "23505") { toast(errorText(error)); return; }
    state.blocked.set(peerId, true); closeChat("User blocked."); await refreshChats();
  };
  $("backBtn").onclick = () => closeChat();
  $("newChatBtn").onclick = () => { $("userSearch").focus(); $("userSearch").placeholder = "Type a username…"; };
  $("welcomeFindBtn").onclick = () => { $("userSearch").focus(); $("userSearch").placeholder = "Type a username…"; };

  /* ---------- invite ---------- */
  function profileLink() { return location.origin + location.pathname + "?u=" + encodeURIComponent(state.profile.username); }
  async function shareInvite() {
    const url = profileLink();
    try { if (navigator.share) await navigator.share({ title: "Chat with me on Privy", text: "Open this link to start a private chat with @" + state.profile.username, url }); else { await navigator.clipboard.writeText(url); toast("Invite link copied."); } }
    catch (e) { if (e.name !== "AbortError") toast("Could not share link."); }
  }
  $("shareProfileBtn").onclick = shareInvite; $("shareChatBtn").onclick = shareInvite;

  /* ---------- presence / realtime ---------- */
  async function setupPresence() {
    if (state.presenceChannel) { await state.client.removeChannel(state.presenceChannel); state.presenceChannel = null; }
    state.presenceChannel = state.client.channel("privy-online", { config: { presence: { key: state.user.id } } });
    state.presenceChannel.on("presence", { event: "sync" }, () => { const p = state.presenceChannel.presenceState(); state.online = new Set(Object.keys(p)); renderChats(); updatePeerStatus(); })
      .subscribe(async (status) => { if (status === "SUBSCRIBED") await state.presenceChannel.track({ user_id: state.user.id, online_at: new Date().toISOString() }); });
  }
  async function setupRealtime() {
    // Previously this channel was never removed on sign-out, so every re-login stacked another listener.
    if (state.listChannel) { await state.client.removeChannel(state.listChannel); state.listChannel = null; }
    state.listChannel = state.client.channel("privy-list-updates")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload) => {
        const cid = payload.new?.conversation_id || payload.old?.conversation_id;
        if (cid && cid === state.active) loadMessages();
        scheduleRefresh();
      })
      // DELETE events cannot be filtered by user in Supabase Realtime, so listen unfiltered and just re-check the list.
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_members" }, () => scheduleRefresh())
      .subscribe();
  }
  function updatePeerStatus() {
    if (!state.peer) return;
    const online = state.online.has(state.peer.id);
    $("peerStatus").textContent = online ? "Online now" : state.peer.last_seen ? "Last seen " + niceTime(state.peer.last_seen) : "Offline";
    $("peerStatus").style.color = online ? "#21b785" : "";
  }
  async function pingLastSeen() { if (!state.user) return; await state.client.from("profiles").update({ last_seen: new Date().toISOString() }).eq("id", state.user.id); }
  async function startLastSeen() { await pingLastSeen(); clearInterval(state.lastSeenTimer); state.lastSeenTimer = setInterval(() => { if (document.visibilityState === "visible") pingLastSeen(); }, 60000); }
  document.addEventListener("click", (e) => {
    if (!$("chatMenu").contains(e.target) && e.target !== $("chatMenuBtn")) show($("chatMenu"), false);
    if (!$("searchResults").contains(e.target) && e.target !== $("userSearch")) show($("searchResults"), false);
  });

  /* ---------- boot ---------- */
  async function boot() {
    authMode(false);
    appShell.classList.add("signed-out"); show($("authView"), true); show($("welcomeView"), false); show($("chatView"), false);
    if (!window.supabase) { toast("Could not load Supabase library. Check your internet connection."); return; }
    if (!isConfigured()) return;
    state.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    state.client.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT" && state.user) teardown(); });
    const { data: { session } } = await state.client.auth.getSession();
    if (session) { state.user = session.user; await enterApp(); }
  }
  boot();
})();
