import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_CONFIG } from "./supabase-config.js";

const DEFAULT_CENTER = { lat: 25.0478, lng: 121.5319 };
const STORAGE_KEY = "hide-seek-live-state-v3";
const CONFIG_KEY = "hide-seek-supabase-config";
const LOCATION_SYNC_MS = 500;
const ACTIVE_PLAYER_MS = 8_000;
const PRECISION_WARMUP_MS = 8000;
const PRECISION_SAMPLE_WINDOW_MS = 12000;
const TARGET_ACCURACY_METERS = 20;

const state = {
  phase: "location",
  map: null,
  markers: new Map(),
  supabase: null,
  session: null,
  realtimeChannel: null,
  realtimeRoomCode: "",
  realtimeJoinPromise: null,
  config: { url: "", anonKey: "" },
  roomCode: "main",
  playerName: "玩家 1",
  team: "",
  position: null,
  accuracy: null,
  locationGranted: false,
  usingMockLocation: false,
  watchId: null,
  heartbeatId: null,
  lastSyncAt: 0,
  precisionStartedAt: 0,
  locationSamples: [],
  players: [],
};

const views = {
  location: document.querySelector("#locationView"),
  auth: document.querySelector("#authView"),
  lobby: document.querySelector("#lobbyView"),
  team: document.querySelector("#teamView"),
  game: document.querySelector("#gameView"),
};

const elements = {
  grantLocationButton: document.querySelector("#grantLocationButton"),
  mockLocationButton: document.querySelector("#mockLocationButton"),
  locationMessage: document.querySelector("#locationMessage"),
  supabaseSetup: document.querySelector("#supabaseSetup"),
  supabaseUrl: document.querySelector("#supabaseUrl"),
  supabaseAnonKey: document.querySelector("#supabaseAnonKey"),
  saveSupabaseButton: document.querySelector("#saveSupabaseButton"),
  googleLoginButton: document.querySelector("#googleLoginButton"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  emailSignUpButton: document.querySelector("#emailSignUpButton"),
  emailSignInButton: document.querySelector("#emailSignInButton"),
  authMessage: document.querySelector("#authMessage"),
  signOutButton: document.querySelector("#signOutButton"),
  roomCode: document.querySelector("#roomCode"),
  playerName: document.querySelector("#playerName"),
  startGameButton: document.querySelector("#startGameButton"),
  lobbyMessage: document.querySelector("#lobbyMessage"),
  chooseRedButton: document.querySelector("#chooseRedButton"),
  chooseGreenButton: document.querySelector("#chooseGreenButton"),
  changeTeamButton: document.querySelector("#changeTeamButton"),
  recenterButton: document.querySelector("#recenterButton"),
  hudTitle: document.querySelector("#hudTitle"),
  hudStatus: document.querySelector("#hudStatus"),
  teamBadge: document.querySelector("#teamBadge"),
  playerList: document.querySelector("#playerList"),
  leafletMap: document.querySelector("#leafletMap"),
};

boot();

async function boot() {
  restoreState();
  restoreConfig();
  bindEvents();
  initMap();
  await connectSupabaseIfConfigured();
  showView("location");
  requestLocationOnEntry();
  render();
}

function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.roomCode = saved.roomCode || state.roomCode;
    state.playerName = saved.playerName || state.playerName;
    state.team = saved.team || "";
    state.position = saved.position || null;
    state.accuracy = saved.accuracy || null;
    state.locationGranted = Boolean(saved.locationGranted);
    state.usingMockLocation = Boolean(saved.usingMockLocation);
  } catch {
    state.team = "";
  }

  elements.roomCode.value = state.roomCode;
  elements.playerName.value = state.playerName;
}

function restoreConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    state.config = {
      url: SUPABASE_CONFIG.url || saved.url || "",
      anonKey: SUPABASE_CONFIG.anonKey || saved.anonKey || "",
    };
  } catch {
    state.config = {
      url: SUPABASE_CONFIG.url || "",
      anonKey: SUPABASE_CONFIG.anonKey || "",
    };
  }

  elements.supabaseUrl.value = state.config.url;
  elements.supabaseAnonKey.value = state.config.anonKey;
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      roomCode: state.roomCode,
      playerName: state.playerName,
      team: state.team,
      position: state.position,
      accuracy: state.accuracy,
      locationGranted: state.locationGranted,
      usingMockLocation: state.usingMockLocation,
    }),
  );
}

function bindEvents() {
  elements.grantLocationButton.addEventListener("click", startPreciseLocation);
  elements.mockLocationButton.addEventListener("click", useMockLocation);
  elements.saveSupabaseButton.addEventListener("click", saveSupabaseConfig);
  elements.googleLoginButton?.addEventListener("click", signInWithGoogle);
  elements.emailSignUpButton.addEventListener("click", signUpWithEmail);
  elements.emailSignInButton.addEventListener("click", signInWithEmail);
  elements.signOutButton.addEventListener("click", signOut);
  elements.startGameButton.addEventListener("click", openTeamPicker);
  elements.chooseRedButton.addEventListener("click", () => chooseTeam("red"));
  elements.chooseGreenButton.addEventListener("click", () => chooseTeam("green"));
  elements.changeTeamButton.addEventListener("click", openTeamPicker);
  elements.recenterButton.addEventListener("click", recenterMap);

  elements.roomCode.addEventListener("change", async (event) => {
    state.roomCode = cleanRoomCode(event.target.value);
    elements.roomCode.value = state.roomCode;
    saveState();
    await joinRealtimeRoom();
    await syncOwnPlayer(true);
    render();
  });

  elements.playerName.addEventListener("input", async (event) => {
    state.playerName = event.target.value.trim() || "玩家";
    saveState();
    await syncOwnPlayer(false);
    render();
  });

  window.addEventListener("beforeunload", markOfflineWithKeepalive);
  window.addEventListener("pagehide", markOfflineWithKeepalive);
  window.addEventListener("unload", markOfflineWithKeepalive);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncOwnPlayer(true);
    } else {
      markOfflineWithKeepalive();
    }
  });
}

function initMap() {
  state.map = L.map(elements.leafletMap, {
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,
  }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 17);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxNativeZoom: 20,
    maxZoom: 22,
  }).addTo(state.map);

  L.control.zoom({ position: "bottomright" }).addTo(state.map);
}

function requestLocationOnEntry() {
  if (state.locationGranted && state.position) {
    showNextAfterLocation();
  }

  startPreciseLocation();
}

function startPreciseLocation() {
  if (!("geolocation" in navigator)) {
    setLocationMessage("此瀏覽器不支援定位，請改用模擬位置測試。");
    return;
  }

  setLocationMessage("正在啟動高精度定位，請稍等 GPS 校準。");

  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
  }

  state.precisionStartedAt = Date.now();
  state.locationSamples = [];

  state.watchId = navigator.geolocation.watchPosition(
    handlePrecisePosition,
    (error) => {
      const messages = {
        1: "定位授權被拒絕，請允許位置權限後再繼續。",
        2: "目前無法取得位置，請稍後重試。",
        3: "定位逾時，請再按一次允許定位。",
      };
      setLocationMessage(messages[error.code] || "定位失敗，請重試。");
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 30000,
    },
  );
}

function handlePrecisePosition(position) {
  const fix = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: Math.round(position.coords.accuracy),
    capturedAt: Date.now(),
  };

  state.locationGranted = true;
  state.usingMockLocation = false;
  rememberLocationFix(fix);

  const bestFix = getBestRecentFix();
  const elapsed = Date.now() - state.precisionStartedAt;
  const hasTargetFix = bestFix.accuracy <= TARGET_ACCURACY_METERS;
  const stillWarmingUp = elapsed < PRECISION_WARMUP_MS && !hasTargetFix && !state.position;

  if (stillWarmingUp) {
    setLocationMessage(`正在校準高精度定位，目前最佳精度約 ±${bestFix.accuracy}m。`);
    render();
    return;
  }

  acceptLocationFix(state.position ? fix : bestFix);
}

function rememberLocationFix(fix) {
  state.locationSamples.push(fix);
  state.locationSamples = state.locationSamples.filter(
    (sample) => fix.capturedAt - sample.capturedAt <= PRECISION_SAMPLE_WINDOW_MS,
  );
}

function getBestRecentFix() {
  return [...state.locationSamples].sort((a, b) => a.accuracy - b.accuracy)[0];
}

function acceptLocationFix(fix) {
  state.position = {
    lat: fix.lat,
    lng: fix.lng,
  };
  state.accuracy = fix.accuracy;
  saveState();
  setLocationMessage(`高精度定位中，最佳精度約 ±${state.accuracy}m。`);
  showNextAfterLocation();
  startLocationHeartbeat();
  syncOwnPlayer(false);
  render();
}

function useMockLocation() {
  state.locationGranted = true;
  state.usingMockLocation = true;
  state.position = {
    lat: DEFAULT_CENTER.lat + randomOffset(40),
    lng: DEFAULT_CENTER.lng + randomOffset(40),
  };
  state.accuracy = 8;
  saveState();
  setLocationMessage("目前使用模擬位置。");
  showNextAfterLocation();
  startLocationHeartbeat();
  syncOwnPlayer(true);
  render();
}

function startLocationHeartbeat() {
  if (state.heartbeatId !== null) return;
  state.heartbeatId = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      syncOwnPlayer(false);
    }
  }, LOCATION_SYNC_MS);
}

function showNextAfterLocation() {
  if (!state.locationGranted) return;
  if (["team", "game"].includes(state.phase)) return;

  if (!state.supabase || !state.session) {
    showView("auth");
    return;
  }

  showView(state.team ? "lobby" : "lobby");
}

async function connectSupabaseIfConfigured() {
  if (!state.config.url || !state.config.anonKey) {
    setSupabaseSetupVisible(true);
    setAuthControls(false);
    return;
  }

  await connectSupabase(state.config.url, state.config.anonKey);
}

async function saveSupabaseConfig() {
  const url = elements.supabaseUrl.value.trim();
  const anonKey = elements.supabaseAnonKey.value.trim();

  if (!isValidSupabaseUrl(url) || anonKey.length < 30) {
    setAuthMessage("Supabase URL 或 anon key 格式不正確。");
    return;
  }

  state.config = { url, anonKey };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
  await connectSupabase(url, anonKey);
}

async function connectSupabase(url, anonKey) {
  try {
    state.supabase = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    const { data, error } = await state.supabase.auth.getSession();
    if (error) throw error;
    state.session = data.session;

    state.supabase.auth.onAuthStateChange(async (event, session) => {
      state.session = session;
      setAuthControls(Boolean(session));
      if (session) {
        await upsertProfile();
        await syncOwnPlayer(true);
        await joinRealtimeRoom();
        if (event === "SIGNED_IN" || (event === "INITIAL_SESSION" && ["location", "auth"].includes(state.phase))) {
          showView("lobby");
        }
      } else if (state.locationGranted) {
        showView("auth");
      }
      render();
    });

    setSupabaseSetupVisible(false);
    setAuthControls(Boolean(state.session));
    if (state.session) {
      await upsertProfile();
      await syncOwnPlayer(true);
      await joinRealtimeRoom();
    }
  } catch (error) {
    setSupabaseSetupVisible(true);
    setAuthMessage(error.message || "Supabase 連線失敗。");
  }
}

async function signInWithGoogle() {
  if (!state.supabase) {
    setAuthMessage("請先設定 Supabase。");
    setSupabaseSetupVisible(true);
    return;
  }

  const { error } = await state.supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
    },
  });

  if (error) {
    setAuthMessage(error.message);
  }
}

async function signUpWithEmail() {
  if (!state.supabase) {
    setAuthMessage("請先設定 Supabase。");
    setSupabaseSetupVisible(true);
    return;
  }

  const { email, password } = getEmailCredentials();
  if (!email || password.length < 6) {
    setAuthMessage("請輸入 email，密碼至少 6 個字元。");
    return;
  }

  const { data, error } = await state.supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: state.playerName },
      emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
    },
  });

  if (error) {
    setAuthMessage(error.message);
    return;
  }

  setAuthMessage(data.session ? "註冊成功，已登入。" : "註冊成功，請先到信箱確認。");
}

async function signInWithEmail() {
  if (!state.supabase) {
    setAuthMessage("請先設定 Supabase。");
    setSupabaseSetupVisible(true);
    return;
  }

  const { email, password } = getEmailCredentials();
  if (!email || !password) {
    setAuthMessage("請輸入 email 與密碼。");
    return;
  }

  const { error } = await state.supabase.auth.signInWithPassword({ email, password });
  if (error) {
    setAuthMessage(error.message);
  }
}

async function signOut() {
  await markOffline();
  if (state.supabase) {
    await state.supabase.auth.signOut({ scope: "local" });
  }
  state.session = null;
  state.players = [];
  showView("auth");
  render();
}

function getEmailCredentials() {
  return {
    email: elements.emailInput.value.trim(),
    password: elements.passwordInput.value,
  };
}

async function upsertProfile() {
  if (!state.supabase || !state.session) return;

  const user = state.session.user;
  await state.supabase.from("player_profiles").upsert(
    {
      user_id: user.id,
      email: user.email,
      display_name: state.playerName || getDisplayName(user),
      avatar_url: user.user_metadata?.avatar_url || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
}

function openTeamPicker() {
  if (!state.session) {
    setLobbyMessage("請先登入。");
    showView("auth");
    return;
  }
  showView("team");
}

async function chooseTeam(team) {
  state.team = team;
  saveState();
  showView("game");
  setTimeout(() => state.map.invalidateSize(), 50);
  recenterMap();
  render();
  try {
    await syncOwnPlayer(true);
    await joinRealtimeRoom();
    render();
  } catch (error) {
    setHudStatus(error.message || "選隊同步失敗，請再試一次。");
  }
}

async function joinRealtimeRoom() {
  if (!state.supabase || !state.session) return;

  if (state.realtimeJoinPromise) {
    return state.realtimeJoinPromise;
  }

  if (state.realtimeChannel && state.realtimeRoomCode === state.roomCode) {
    await loadRoomPlayers();
    return;
  }

  state.realtimeJoinPromise = (async () => {
    if (state.realtimeChannel) {
      await state.supabase.removeChannel(state.realtimeChannel);
      state.realtimeChannel = null;
      state.realtimeRoomCode = "";
    }

    await loadRoomPlayers();

    const topic = `hide-seek-${state.roomCode}-${state.session.user.id}`;
    state.realtimeChannel = state.supabase
      .channel(topic)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "game_players",
          filter: `room_code=eq.${state.roomCode}`,
        },
        (payload) => {
          applyRealtimePayload(payload);
          render();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          state.realtimeRoomCode = state.roomCode;
          setHudStatus("即時同步中");
        } else if (status === "CHANNEL_ERROR") {
          setHudStatus("同步連線失敗");
        }
      });
  })();

  try {
    await state.realtimeJoinPromise;
  } finally {
    state.realtimeJoinPromise = null;
  }
}

async function loadRoomPlayers() {
  if (!state.supabase || !state.session) return;

  const { data, error } = await state.supabase
    .from("game_players")
    .select("user_id,email,display_name,team,room_code,lat,lng,accuracy,is_online,updated_at")
    .eq("room_code", state.roomCode)
    .eq("is_online", true)
    .gte("updated_at", getActiveSinceIso())
    .order("updated_at", { ascending: false });

  if (error) {
    setHudStatus(error.message);
    return;
  }

  state.players = data.map(fromDatabasePlayer);
}

function applyRealtimePayload(payload) {
  if (payload.eventType === "DELETE" && payload.old?.user_id) {
    state.players = state.players.filter((player) => player.userId !== payload.old.user_id);
    return;
  }

  if (!payload.new?.user_id) return;

  const next = fromDatabasePlayer(payload.new);
  if (!isPlayerActive(next)) {
    state.players = state.players.filter((player) => player.userId !== next.userId);
    return;
  }

  const existingIndex = state.players.findIndex((player) => player.userId === next.userId);
  if (existingIndex >= 0) {
    state.players[existingIndex] = next;
  } else {
    state.players.push(next);
  }
}

function fromDatabasePlayer(record) {
  const userId = record.user_id;
  return {
    id: userId,
    userId,
    email: record.email || "",
    name: record.display_name || record.email || "玩家",
    team: record.team === "green" ? "green" : "red",
    roomCode: record.room_code || state.roomCode,
    lat: Number(record.lat || DEFAULT_CENTER.lat),
    lng: Number(record.lng || DEFAULT_CENTER.lng),
    accuracy: record.accuracy || 0,
    isOnline: record.is_online !== false,
    updatedAt: record.updated_at,
    self: userId === state.session?.user?.id,
  };
}

async function syncOwnPlayer(force) {
  if (!state.supabase || !state.session || !state.position) return;
  if (document.visibilityState === "hidden") return;
  if (!force && Date.now() - state.lastSyncAt < LOCATION_SYNC_MS) return;

  state.lastSyncAt = Date.now();
  const user = state.session.user;
  const payload = {
    user_id: user.id,
    email: user.email,
    display_name: state.playerName || getDisplayName(user),
    team: state.team || "green",
    room_code: state.roomCode,
    lat: state.position.lat,
    lng: state.position.lng,
    accuracy: state.accuracy || null,
    is_online: true,
    updated_at: new Date().toISOString(),
  };

  const { error } = await state.supabase.from("game_players").upsert(payload, {
    onConflict: "user_id",
  });

  if (error) {
    setHudStatus(error.message);
    setLobbyMessage(error.message);
    return;
  }

  applyRealtimePayload({ eventType: "UPDATE", new: payload });
  setHudStatus(`定位同步中 · ±${state.accuracy || "--"}m`);
}

async function markOffline() {
  if (!state.supabase || !state.session) return;

  await state.supabase
    .from("game_players")
    .delete()
    .eq("user_id", state.session.user.id);
}

function markOfflineWithKeepalive() {
  if (!state.config.url || !state.config.anonKey || !state.session?.access_token) return;

  const endpoint = `${state.config.url}/rest/v1/game_players?user_id=eq.${state.session.user.id}`;

  fetch(endpoint, {
    method: "DELETE",
    headers: {
      apikey: state.config.anonKey,
      authorization: `Bearer ${state.session.access_token}`,
      prefer: "return=minimal",
    },
    keepalive: true,
  }).catch(() => {});
}

function render() {
  renderAuthSetup();
  renderHud();
  renderPlayers();
  renderMarkers();
  saveState();
}

function renderAuthSetup() {
  const hasSupabase = Boolean(state.supabase);
  if (elements.googleLoginButton) {
    elements.googleLoginButton.disabled = !hasSupabase;
  }
  elements.emailSignUpButton.disabled = !hasSupabase;
  elements.emailSignInButton.disabled = !hasSupabase;
  elements.signOutButton.classList.toggle("hidden", !state.session);
}

function renderHud() {
  const room = state.roomCode.toUpperCase();
  elements.hudTitle.textContent = `${room} 房間`;
  elements.teamBadge.textContent = state.team === "red" ? "紅隊：尋找方" : state.team === "green" ? "綠隊：躲藏方" : "未選隊";
  elements.teamBadge.className = `team-badge ${state.team === "red" ? "red-badge" : state.team === "green" ? "green-badge" : ""}`;

  if (!elements.hudStatus.textContent || elements.hudStatus.textContent === "等待同步") {
    setHudStatus(state.position ? `定位中 · ±${state.accuracy || "--"}m` : "等待定位");
  }
}

function renderPlayers() {
  const players = getVisiblePlayers();
  const hiddenCount = getSameRoomPlayers().length - players.length;
  const rows = players.map((player) => {
    const distance = state.position ? `${Math.round(distanceInMeters(state.position, player))}m` : "--";
    const teamLabel = player.team === "red" ? "紅隊" : "綠隊";
    const onlineLabel = player.isOnline ? "在線" : "離線";
    return `
      <div class="player-row ${player.isOnline ? "" : "offline"}">
        <span class="player-dot ${player.team === "red" ? "red-dot" : "green-dot"}"></span>
        <span>
          <strong>${escapeHtml(player.name)}${player.self ? "（你）" : ""}</strong>
          <small>${teamLabel} · ${onlineLabel} · ${distance}</small>
        </span>
      </div>
    `;
  });

  if (hiddenCount > 0) {
    const hiddenTeamLabel = state.team === "red" ? "紅隊隊友" : state.team === "green" ? "綠隊隊友" : "隊友";
    rows.push(`
      <div class="player-row hidden-row">
        <span class="player-dot hidden-dot"></span>
        <span>
          <strong>已隱藏 ${hiddenCount} 名${hiddenTeamLabel}</strong>
          <small>目前規則只顯示敵隊位置，不顯示隊友位置</small>
        </span>
      </div>
    `);
  }

  if (!rows.length) {
    rows.push(`
      <div class="player-row hidden-row">
        <span class="player-dot hidden-dot"></span>
        <span>
          <strong>等待玩家進入</strong>
          <small>同房間登入後會出現在這裡</small>
        </span>
      </div>
    `);
  }

  elements.playerList.innerHTML = rows.join("");
}

function renderMarkers() {
  const players = getVisiblePlayers();
  const visibleIds = new Set(players.map((player) => player.id));

  state.markers.forEach((marker, id) => {
    if (!visibleIds.has(id)) {
      marker.remove();
      state.markers.delete(id);
    }
  });

  players.forEach((player) => {
    const icon = L.divIcon({
      html: `<span class="custom-marker marker-${player.team}${player.self ? " marker-self" : ""}">${player.self ? "我" : player.team === "red" ? "紅" : "綠"}</span>`,
      className: "",
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const latLng = [player.lat, player.lng];

    if (!state.markers.has(player.id)) {
      state.markers.set(player.id, L.marker(latLng, { icon }).addTo(state.map));
    } else {
      state.markers.get(player.id).setLatLng(latLng).setIcon(icon);
    }
  });
}

function getVisiblePlayers() {
  const players = getSameRoomPlayers();
  if (state.team === "red") {
    return players.filter((player) => player.self || player.team === "green");
  }
  if (state.team === "green") {
    return players.filter((player) => player.self || player.team === "red");
  }
  return players.filter((player) => player.self);
}

function getSameRoomPlayers() {
  const players = state.players.filter((player) => player.roomCode === state.roomCode && (player.self || isPlayerActive(player)));

  if (!state.session && state.position) {
    return [
      {
        id: "local-me",
        userId: null,
        name: state.playerName,
        team: state.team || "green",
        roomCode: state.roomCode,
        lat: state.position.lat,
        lng: state.position.lng,
        accuracy: state.accuracy || 8,
        isOnline: true,
        self: true,
      },
    ];
  }

  return players;
}

function isPlayerActive(player) {
  if (!player.isOnline) return false;
  if (!player.updatedAt) return false;
  const updatedAt = Date.parse(player.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= ACTIVE_PLAYER_MS;
}

function getActiveSinceIso() {
  return new Date(Date.now() - ACTIVE_PLAYER_MS).toISOString();
}

function recenterMap() {
  const center = state.position || DEFAULT_CENTER;
  state.map.setView([center.lat, center.lng], 17, { animate: true });
}

function showView(name) {
  state.phase = name;
  Object.entries(views).forEach(([key, view]) => {
    view.classList.toggle("hidden", key !== name);
  });

  if (name === "game") {
    setTimeout(() => state.map.invalidateSize(), 80);
  }
}

function setSupabaseSetupVisible(isVisible) {
  elements.supabaseSetup.classList.toggle("hidden", !isVisible);
}

function setAuthControls(isReady) {
  if (elements.googleLoginButton) {
    elements.googleLoginButton.disabled = !state.supabase;
  }
  elements.emailSignUpButton.disabled = !state.supabase || isReady;
  elements.emailSignInButton.disabled = !state.supabase || isReady;
}

function setLocationMessage(text) {
  elements.locationMessage.textContent = text;
}

function setAuthMessage(text) {
  elements.authMessage.textContent = text;
}

function setLobbyMessage(text) {
  elements.lobbyMessage.textContent = text;
}

function setHudStatus(text) {
  elements.hudStatus.textContent = text;
}

function getDisplayName(user) {
  return user?.user_metadata?.full_name || user?.email || "玩家";
}

function isValidSupabaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".supabase.co");
  } catch {
    return false;
  }
}

function cleanRoomCode(value) {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return cleaned || "main";
}

function randomOffset(radiusMeters) {
  const metersPerDegree = 111_320;
  return ((Math.random() * 2 - 1) * radiusMeters) / metersPerDegree;
}

function distanceInMeters(from, to) {
  const earthRadius = 6_371_000;
  const lat1 = degreesToRadians(from.lat);
  const lat2 = degreesToRadians(to.lat);
  const deltaLat = degreesToRadians(to.lat - from.lat);
  const deltaLng = degreesToRadians(to.lng - from.lng);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
