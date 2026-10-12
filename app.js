/* Privy PWA — configure the Supabase URL and publishable/anon key below.
   Never place a Supabase secret or service_role key in browser code. */
(() => {
  "use strict";
  const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY";
  const BUCKET = "chat-photos";
  const $ = (id) => document.getElementById(id);
  const state = { client:null, user:null, profile:null, signup:false, chats:[], active:null, messages:[], peer:null, selectedPhoto:null, channel:null, presenceChannel:null, online:new Set(), typingTimer:null, modalResolve:null, searchTimer:null, lastSeenTimer:null };
  const appShell = document.querySelector(".app-shell");

  function toast(message) { const el=$("toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove("show"),3200); }
  function show(el, yes=true){ el.classList.toggle("hidden",!yes); }
  function esc(s=""){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function initials(name="User"){ return name.trim().slice(0,1).toUpperCase() || "?"; }
  function avatarHTML(profile, extra=""){ const name=profile?.display_name||profile?.username||"User"; return `<div class="avatar ${extra}">${profile?.avatar_url?`<img alt="" src="${esc(profile.avatar_url)}">`:esc(initials(name))}</div>`; }
  function setAvatar(el, profile){ el.innerHTML=profile?.avatar_url?`<img alt="" src="${esc(profile.avatar_url)}">`:esc(initials(profile?.display_name||profile?.username||"User")); }
  function niceTime(value){ if(!value)return ""; const d=new Date(value), now=new Date(); if(d.toDateString()===now.toDateString()) return d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}); return d.toLocaleDateString([], {month:"short",day:"numeric"}); }
  function errorText(error){ return error?.message || "Something went wrong. Please try again."; }
  function ensureConfigured(){
    if(!window.supabase){ toast("Could not load Supabase library."); return false; }
    if(SUPABASE_URL.includes("YOUR_PROJECT") || SUPABASE_PUBLISHABLE_KEY.includes("YOUR_")){ toast("First add your Supabase URL and publishable key in app.js."); return false; }
    return true;
  }
  function modal(title, text, confirm="Confirm", danger=false){
    $("modalTitle").textContent=title; $("modalText").textContent=text; $("modalConfirm").textContent=confirm; $("modalConfirm").classList.toggle("danger-text",danger);
    show($("modalBackdrop")); return new Promise(resolve=>state.modalResolve=resolve);
  }
  $("modalCancel").onclick=()=>{show($("modalBackdrop"),false);state.modalResolve?.(false);};
  $("modalConfirm").onclick=()=>{show($("modalBackdrop"),false);state.modalResolve?.(true);};
  function authMode(signup){ state.signup=signup; $("authTitle").textContent=signup?"Create your account.":"Welcome back."; $("authSubtitle").textContent=signup?"A username helps friends find you.":"Sign in to continue your conversations."; $("authSubmit").innerHTML=signup?'Create account <span>→</span>':'Sign in <span>→</span>'; $("switchText").textContent=signup?"Already have an account?":"New to Privy?"; $("authSwitch").textContent=signup?"Sign in":"Create account"; show($("usernameLabel"),signup); $("authUsername").required=signup; $("authPassword").autocomplete=signup?"new-password":"current-password"; }
  $("authSwitch").onclick=()=>authMode(!state.signup);
  $("authForm").addEventListener("submit",async e=>{
    e.preventDefault(); if(!ensureConfigured())return;
    const email=$("authEmail").value.trim(), password=$("authPassword").value, username=$("authUsername").value.trim().toLowerCase();
    const btn=$("authSubmit"); btn.disabled=true;
    try{
      if(state.signup){
        if(!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error("Username must be 3–24 characters: letters, numbers or underscore.");
        const {data,error}=await state.client.auth.signUp({email,password,options:{data:{username,display_name:username}}});
        if(error)throw error;
        if(data.session){ state.user=data.user; await ensureProfile(username); await enterApp(); }
        else toast("Account created. Check your email to confirm, then sign in.");
      } else {
        const {data,error}=await state.client.auth.signInWithPassword({email,password}); if(error)throw error; state.user=data.user; await enterApp();
      }
    }catch(err){toast(errorText(err));}finally{btn.disabled=false;}
  });
  async function ensureProfile(usernameHint){
    const {data:existing,error}=await state.client.from("profiles").select("*").eq("id",state.user.id).maybeSingle();
    if(error)throw error;
    if(existing){state.profile=existing;return existing;}
    const meta=state.user.user_metadata||{};
    const username=(usernameHint||meta.username||state.user.email.split("@")[0]).toLowerCase();
    const row={id:state.user.id,username,display_name:meta.display_name||username};
    const {data,error:insertError}=await state.client.from("profiles").insert(row).select().single();
    if(insertError)throw insertError; state.profile=data; return data;
  }
  async function enterApp(){
    try{await ensureProfile();}catch(e){toast("Profile setup failed: "+errorText(e));return;}
    show($("authView"),false); show($("welcomeView"),true); show($("chatView"),false);
    $("myName").textContent=state.profile.display_name||state.profile.username; $("myEmail").textContent="@"+state.profile.username; setAvatar($("myAvatar"),state.profile);
    await refreshChats(); setupPresence(); setupRealtime(); startLastSeen();
    const params=new URLSearchParams(location.search), invite=params.get("u");
    if(invite){ history.replaceState({}, "", location.pathname); await openUsername(invite); }
  }
  async function signOut(){
    if(state.channel) await state.client.removeChannel(state.channel);
    if(state.presenceChannel) await state.client.removeChannel(state.presenceChannel);
    clearInterval(state.lastSeenTimer); await state.client.auth.signOut(); state.user=null;state.profile=null;state.active=null;state.peer=null;state.chats=[];
    appShell.classList.remove("chat-open"); show($("chatView"),false);show($("welcomeView"),false);show($("authView"),true);authMode(false);renderChats();
  }
  $("signOutBtn").onclick=signOut;
  async function refreshChats(){
    if(!state.user)return;
    const {data:members,error}=await state.client.from("conversation_members").select("conversation_id, conversations(id,created_at,updated_at)").eq("user_id",state.user.id).is("deleted_at",null);
    if(error){console.error(error);toast("Could not load conversations: "+error.message);return;}
    const ids=(members||[]).map(x=>x.conversation_id);
    if(!ids.length){state.chats=[];renderChats();return;}
    const {data:allMembers,error:me}=await state.client.from("conversation_members").select("conversation_id,user_id,profiles(id,username,display_name,avatar_url,last_seen)").in("conversation_id",ids).neq("user_id",state.user.id).is("deleted_at",null);
    if(me){console.error(me);return;}
    const {data:latest}=await state.client.from("messages").select("conversation_id,body,photo_path,created_at,sender_id,deleted_at").in("conversation_id",ids).is("deleted_at",null).order("created_at",{ascending:false});
    state.chats=ids.map(id=>{
      const member=members.find(m=>m.conversation_id===id), other=(allMembers||[]).find(m=>m.conversation_id===id), msg=(latest||[]).find(m=>m.conversation_id===id);
      return {id,created_at:member?.conversations?.created_at,updated_at:member?.conversations?.updated_at,peer:other?.profiles||null,last:msg||null};
    }).filter(c=>c.peer).sort((a,b)=>new Date(b.last?.created_at||b.updated_at||b.created_at)-new Date(a.last?.created_at||a.updated_at||a.created_at));
    renderChats();
  }
  function renderChats(){
    const root=$("chatList");
    if(!state.chats.length){root.innerHTML='<div class="empty-side">No conversations yet.<br>Search for a username to start one.</div>';return;}
    root.innerHTML=state.chats.map(c=>`<button class="chat-item ${state.active===c.id?"active":""}" data-chat="${c.id}">${avatarHTML(c.peer)}<div class="chat-item-copy"><div class="chat-item-top"><strong>${esc(c.peer.display_name||c.peer.username)}</strong><span class="chat-time">${niceTime(c.last?.created_at||c.updated_at)}</span></div><span class="chat-preview">${c.last?(c.last.photo_path?"▧ Photo":esc(c.last.body||"")):"Start a conversation"}</span></div>${state.online.has(c.peer.id)?'<span class="unread-dot" title="Online"></span>':""}</button>`).join("");
    root.querySelectorAll("[data-chat]").forEach(b=>b.onclick=()=>openChat(b.dataset.chat));
  }
  $("userSearch").addEventListener("input",()=>{
    clearTimeout(state.searchTimer); const q=$("userSearch").value.trim().replace(/^@/,"");
    if(q.length<2){show($("searchResults"),false);return;}
    state.searchTimer=setTimeout(()=>searchUsers(q),250);
  });
  async function searchUsers(q){
    const {data,error}=await state.client.from("profiles").select("id,username,display_name,avatar_url,last_seen").ilike("username",q+"%").neq("id",state.user.id).limit(12);
    if(error){toast(errorText(error));return;}
    const results=(data||[]).filter(p=>!isBlocked(p.id));
    $("searchResults").innerHTML=results.length?results.map(p=>`<button class="search-result" data-user="${p.id}">${avatarHTML(p)}<div><span>${esc(p.display_name||p.username)}</span><small>@${esc(p.username)}</small></div></button>`).join(""):'<div class="empty-side">No matching usernames found.</div>';
    show($("searchResults")); $("searchResults").querySelectorAll("[data-user]").forEach(b=>b.onclick=()=>startChat(b.dataset.user));
  }
  async function isBlocked(userId){
    const {data}=await state.client.from("blocks").select("blocker_id,blocked_id").or(`and(blocker_id.eq.${state.user.id},blocked_id.eq.${userId}),and(blocker_id.eq.${userId},blocked_id.eq.${state.user.id})`).limit(1);
    return !!data?.length;
  }
  async function openUsername(username){
    const {data,error}=await state.client.from("profiles").select("id").eq("username",username.toLowerCase()).maybeSingle();
    if(error||!data){toast("That invite username was not found.");return;} await startChat(data.id);
  }
  async function startChat(peerId){
    if(peerId===state.user.id)return toast("You cannot start a chat with yourself.");
    if(await isBlocked(peerId))return toast("This chat is unavailable because one of you has blocked the other.");
    const {data,error}=await state.client.rpc("start_conversation",{peer_user_id:peerId});
    if(error){toast(errorText(error));return;}
    $("userSearch").value="";show($("searchResults"),false); await refreshChats(); await openChat(data);
  }
  async function openChat(id){
    const chat=state.chats.find(c=>c.id===id);
    if(!chat){await refreshChats();}
    const chosen=state.chats.find(c=>c.id===id); if(!chosen)return;
    state.active=id;state.peer=chosen.peer;renderChats();
    $("peerName").textContent=chosen.peer.display_name||chosen.peer.username; setAvatar($("peerAvatar"),chosen.peer);
    updatePeerStatus(); show($("welcomeView"),false);show($("chatView"),true);appShell.classList.add("chat-open");show($("chatMenu"),false);
    if(state.channel)await state.client.removeChannel(state.channel);
    await loadMessages();
    state.channel=state.client.channel("chat:"+id,{config:{presence:{key:state.user.id}}});
    state.channel.on("postgres_changes",{event:"*",schema:"public",table:"messages",filter:"conversation_id=eq."+id},async()=>{await loadMessages();await refreshChats();})
      .on("postgres_changes",{event:"*",schema:"public",table:"conversation_members",filter:"conversation_id=eq."+id},async()=>{await refreshChats();if(!state.chats.some(c=>c.id===id)){toast("This conversation is no longer available.");state.active=null;show($("chatView"),false);show($("welcomeView"),true);appShell.classList.remove("chat-open");}})
      .on("broadcast",{event:"typing"},payload=>{if(payload.payload?.user_id!==state.user.id){show($("typingLine"),!!payload.payload?.typing);clearTimeout(state.typingTimer);state.typingTimer=setTimeout(()=>show($("typingLine"),false),1800);}})
      .subscribe();
    await markRead();
  }
  async function loadMessages(){
    if(!state.active)return;
    const {data,error}=await state.client.from("messages").select("*").eq("conversation_id",state.active).is("deleted_at",null).order("created_at",{ascending:true}).limit(500);
    if(error){toast("Could not load messages: "+errorText(error));return;}
    state.messages=data||[];renderMessages();
  }
  async function renderMessages(){
    const area=$("messageArea"), oldBottom=area.scrollHeight-area.scrollTop-area.clientHeight<100;
    if(!state.messages.length){area.innerHTML='<div class="day-label"><span>YOUR CONVERSATION</span></div><div class="message-empty"><b>It starts with a hello.</b>Send a message or share a photo to get things going.</div>';return;}
    const rows=[];
    for(const m of state.messages){
      let photo="";
      if(m.photo_path){const {data}=await state.client.storage.from(BUCKET).createSignedUrl(m.photo_path,3600);if(data?.signedUrl)photo=`<img class="message-photo" src="${esc(data.signedUrl)}" alt="Shared photo" loading="lazy" data-photo="${esc(data.signedUrl)}">`;else photo='<div class="muted">Photo unavailable</div>';}
      const mine=m.sender_id===state.user.id, time=niceTime(m.created_at);
      rows.push(`<div class="message-row ${mine?"mine":""}" data-message="${m.id}"><div class="message-bubble">${photo}${m.body?esc(m.body):""}<span class="message-time">${time}${mine?(m.read_at?" · Seen":" · Sent"):""}</span></div>${mine?`<div class="message-actions"><button class="mini-btn" data-delete="${m.id}" title="Delete message for everyone">Delete</button></div>`:""}</div>`);
    }
    area.innerHTML='<div class="day-label"><span>YOUR CONVERSATION</span></div>'+rows.join("");
    area.querySelectorAll("[data-delete]").forEach(b=>b.onclick=()=>deleteMessage(b.dataset.delete));
    area.querySelectorAll("[data-photo]").forEach(img=>img.onclick=()=>window.open(img.dataset.photo,"_blank","noopener"));
    if(oldBottom)area.scrollTop=area.scrollHeight;
  }
  async function markRead(){
    if(!state.active)return;
    const {error}=await state.client.rpc("mark_messages_read",{target_conversation_id:state.active});
    if(error)console.warn("Read receipt:",error.message);
  }
  async function sendMessage(){
    const body=$("messageInput").value.trim(), file=state.selectedPhoto;
    if(!body&&!file)return;
    if(!state.active)return toast("Choose a conversation first.");
    if(body.length>4000)return toast("Message is too long.");
    $("sendBtn").disabled=true;
    try{
      let photo_path=null;
      if(file){
        if(!file.type.startsWith("image/"))throw new Error("Please select an image.");
        if(file.size>8*1024*1024)throw new Error("Images must be 8 MB or smaller.");
        const ext=(file.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"")||"jpg";
        photo_path=`${state.active}/${state.user.id}/${crypto.randomUUID()}.${ext}`;
        const {error}=await state.client.storage.from(BUCKET).upload(photo_path,file,{contentType:file.type,upsert:false,cacheControl:"3600"});
        if(error)throw error;
      }
      const {error}=await state.client.from("messages").insert({conversation_id:state.active,sender_id:state.user.id,body:body||null,photo_path});
      if(error){if(photo_path)await state.client.storage.from(BUCKET).remove([photo_path]);throw error;}
      $("messageInput").value="";$("messageInput").style.height="auto";clearPhoto();await loadMessages();await refreshChats();
    }catch(e){toast(errorText(e));}finally{$("sendBtn").disabled=false;$("messageInput").focus();}
  }
  $("composer").addEventListener("submit",e=>{e.preventDefault();sendMessage();});
  $("messageInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();}});
  $("messageInput").addEventListener("input",()=>{
    const el=$("messageInput");el.style.height="auto";el.style.height=Math.min(el.scrollHeight,130)+"px";
    if(state.channel){state.channel.send({type:"broadcast",event:"typing",payload:{user_id:state.user.id,typing:true}});clearTimeout(state.typingTimer);state.typingTimer=setTimeout(()=>state.channel?.send({type:"broadcast",event:"typing",payload:{user_id:state.user.id,typing:false}}),1200);}
  });
  $("attachBtn").onclick=()=>$("photoInput").click();
  $("photoInput").onchange=()=>{const f=$("photoInput").files?.[0];if(!f)return;if(!f.type.startsWith("image/"))return toast("Choose an image file.");if(f.size>8*1024*1024){$("photoInput").value="";return toast("Images must be 8 MB or smaller.");}state.selectedPhoto=f;$("photoPreview").innerHTML=`<img src="${URL.createObjectURL(f)}" alt="Photo preview"><button type="button" id="removePhoto" aria-label="Remove photo">×</button>`;show($("photoPreview"));$("removePhoto").onclick=clearPhoto;};
  function clearPhoto(){state.selectedPhoto=null;$("photoInput").value="";$("photoPreview").innerHTML="";show($("photoPreview"),false);}
  async function deleteMessage(id){
    const yes=await modal("Delete this message?","It will be removed from this conversation for both people. This cannot be undone.","Delete",true);if(!yes)return;
    const msg=state.messages.find(m=>m.id===id);if(!msg||msg.sender_id!==state.user.id)return toast("You can only delete your own messages.");
    const {error}=await state.client.rpc("delete_message_everyone",{target_message_id:id});
    if(error){toast(errorText(error));return;}
    if(msg.photo_path)await state.client.storage.from(BUCKET).remove([msg.photo_path]);
    await loadMessages();await refreshChats();toast("Message deleted for everyone.");
  }
  async function deleteChat(){
    if(!state.active)return;
    const yes=await modal("Delete chat for both?","This permanently removes the conversation and its messages from both users' chat lists. This cannot be undone.","Delete chat",true);if(!yes)return;
    const id=state.active;
    // Best-effort photo cleanup before deleting the conversation.
    try{
      const {data:members}=await state.client.from("conversation_members").select("user_id").eq("conversation_id",id);
      const {data:files}=await state.client.storage.from(BUCKET).list(id,{limit:1000});
      for(const folder of (files||[]).filter(f=>!f.id)){
        const {data:inside}=await state.client.storage.from(BUCKET).list(id+"/"+folder.name,{limit:1000});
        const paths=(inside||[]).map(f=>id+"/"+folder.name+"/"+f.name);if(paths.length)await state.client.storage.from(BUCKET).remove(paths);
      }
    }catch(e){console.warn("Photo cleanup incomplete",e);}
    const {error}=await state.client.rpc("delete_conversation_everyone",{target_conversation_id:id});
    if(error){toast(errorText(error));return;}
    if(state.channel)await state.client.removeChannel(state.channel);state.channel=null;state.active=null;state.peer=null;
    await refreshChats();show($("chatView"),false);show($("welcomeView"),true);appShell.classList.remove("chat-open");toast("Conversation deleted for both users.");
  }
  $("chatMenuBtn").onclick=()=>show($("chatMenu"));
  $("deleteChatBtn").onclick=()=>{show($("chatMenu"),false);deleteChat();};
  $("blockBtn").onclick=async()=>{
    show($("chatMenu"),false);if(!state.peer)return;
    const yes=await modal("Block this user?","They won't be able to start a conversation with you while the block is active.","Block user",true);if(!yes)return;
    const {error}=await state.client.from("blocks").insert({blocker_id:state.user.id,blocked_id:state.peer.id});
    if(error&&error.code!=="23505"){toast(errorText(error));return;}
    toast("User blocked.");state.active=null;state.peer=null;await refreshChats();show($("chatView"),false);show($("welcomeView"),true);appShell.classList.remove("chat-open");
  };
  $("backBtn").onclick=()=>{appShell.classList.remove("chat-open");state.active=null;show($("chatView"),false);show($("welcomeView"),true);};
  $("newChatBtn").onclick=()=>{$("userSearch").focus();$("userSearch").placeholder="Type a username…";};
  $("welcomeFindBtn").onclick=()=>{$("userSearch").focus();$("userSearch").placeholder="Type a username…";};
  function profileLink(){return location.origin+location.pathname+"?u="+encodeURIComponent(state.profile.username);}
  async function shareInvite(){const url=profileLink();try{if(navigator.share)await navigator.share({title:"Chat with me on Privy",text:"Open this link to start a private chat with @"+state.profile.username,url});else{await navigator.clipboard.writeText(url);toast("Invite link copied.");}}catch(e){if(e.name!=="AbortError")toast("Could not share link.");}}
  $("shareProfileBtn").onclick=shareInvite;$("shareChatBtn").onclick=shareInvite;
  function setupPresence(){
    if(state.presenceChannel)state.client.removeChannel(state.presenceChannel);
    state.presenceChannel=state.client.channel("privy-online",{config:{presence:{key:state.user.id}}});
    state.presenceChannel.on("presence",{event:"sync"},()=>{const p=state.presenceChannel.presenceState();state.online=new Set(Object.keys(p));renderChats();updatePeerStatus();})
      .subscribe(async status=>{if(status==="SUBSCRIBED")await state.presenceChannel.track({user_id:state.user.id,username:state.profile.username,online_at:new Date().toISOString()});});
  }
  function setupRealtime(){
    state.client.channel("privy-list-updates")
      .on("postgres_changes",{event:"*",schema:"public",table:"conversation_members",filter:"user_id=eq."+state.user.id},()=>refreshChats())
      .on("postgres_changes",{event:"*",schema:"public",table:"messages"},payload=>{if(payload.new?.conversation_id===state.active||payload.old?.conversation_id===state.active)loadMessages();refreshChats();})
      .subscribe();
  }
  function updatePeerStatus(){
    if(!state.peer)return;
    const online=state.online.has(state.peer.id);
    $("peerStatus").textContent=online?"Online now":state.peer.last_seen?"Last seen "+niceTime(state.peer.last_seen):"Offline";
    $("peerStatus").style.color=online?"#21b785":"";
  }
  async function startLastSeen(){
    const ping=async()=>{if(!state.user)return;await state.client.from("profiles").update({last_seen:new Date().toISOString()}).eq("id",state.user.id);};
    await ping();clearInterval(state.lastSeenTimer);state.lastSeenTimer=setInterval(ping,60000);
  }
  $("modalBackdrop").addEventListener("click",e=>{if(e.target===$("modalBackdrop"))$("modalCancel").click();});
  document.addEventListener("click",e=>{if(!$("chatMenu").contains(e.target)&&e.target!==$("chatMenuBtn"))show($("chatMenu"),false);if(!$("searchResults").contains(e.target)&&e.target!==$("userSearch"))show($("searchResults"),false);});
  async function boot(){
    if(!window.supabase)return;
    if(SUPABASE_URL.includes("YOUR_PROJECT")||SUPABASE_PUBLISHABLE_KEY.includes("YOUR_")){authMode(false);return;}
    state.client=window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
    const {data:{session}}=await state.client.auth.getSession();
    if(session){state.user=session.user;await enterApp();}
    else {show($("authView"),true);show($("welcomeView"),false);show($("chatView"),false);authMode(false);}
    state.client.auth.onAuthStateChange((event,session)=>{if(event==="SIGNED_OUT"){state.user=null;}});
    if("serviceWorker"in navigator)navigator.serviceWorker.register("./sw.js").catch(console.warn);
  }
  boot();
})();