import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_CONFIG } from "./supabase-config.js";

const DEFAULT_CENTER = { lat: 25.0478, lng: 121.5319 };
const STORAGE_KEY = "hide-seek-live-state-v3";
const CONFIG_KEY = "hide-seek-supabase-config";
const LOCATION_SYNC_MS = 1_200;
const LOCATION_REFRESH_MS = 3_000;
const ROOM_STATUS_POLL_MS = 1_500;
const ACTIVE_PLAYER_MS = 15_000;
const PRECISION_WARMUP_MS = 0;
const PRECISION_SAMPLE_WINDOW_MS = 12000;
const TARGET_ACCURACY_METERS = 20;
const ROOM_SELECT = "*";

const state = {
  phase: "location",
  map: null,
  markers: new Map(),
  supabase: null,
  session: null,
  realtimeChannel: null,
  realtimeRoomCode: "",
  realtimeJoinPromise: null,
  room: null,
  hasPlayerRow: false,
  joinInProgress: false,
  endRedirectTimer: null,
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
  permissionMonitorId: null,
  lastSyncAt: 0,
  lastRoomPollAt: 0,
  lastLocationFixAt: 0,
  locationRefreshInProgress: false,
  permissionCheckInProgress: false,
  locationPermissionStatusBound: false,
  locationPermissionBlocked: false,
  syncInProgress: false,
  syncPromise: null,
  roomPollInProgress: false,
  precisionStartedAt: 0,
  locationSamples: [],
  players: [],
  lastBroadcastAt: "",
};

const views = {
  location: document.querySelector("#locationView"),
  auth: document.querySelector("#authView"),
  lobby: document.querySelector("#lobbyView"),
  waiting: document.querySelector("#waitingView"),
  ended: document.querySelector("#endedView"),
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
  waitingRoomTitle: document.querySelector("#waitingRoomTitle"),
  waitingMessage: document.querySelector("#waitingMessage"),
  leaveRoomButton: document.querySelector("#leaveRoomButton"),
  recenterButton: document.querySelector("#recenterButton"),
  hudTitle: document.querySelector("#hudTitle"),
  hudStatus: document.querySelector("#hudStatus"),
  teamBadge: document.querySelector("#teamBadge"),
  playerList: document.querySelector("#playerList"),
  broadcastToast: document.querySelector("#broadcastToast"),
  broadcastText: document.querySelector("#broadcastText"),
  closeBroadcastButton: document.querySelector("#closeBroadcastButton"),
  leafletMap: document.querySelector("#leafletMap"),
};

boot();

async function boot() {
  restoreState();
  restoreConfig();
  bindEvents();
  initMap();
  startLocationPermissionMonitor();
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
    state.lastBroadcastAt = saved.lastBroadcastAt || "";
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
      lastBroadcastAt: state.lastBroadcastAt,
    }),
  );
}

function bindEvents() {
  elements.grantLocationButton.addEventListener("click", startPreciseLocation);
  elements.mockLocationButton?.addEventListener("click", useMockLocation);
  elements.saveSupabaseButton.addEventListener("click", saveSupabaseConfig);
  elements.googleLoginButton?.addEventListener("click", signInWithGoogle);
  elements.emailSignUpButton.addEventListener("click", signUpWithEmail);
  elements.emailSignInButton.addEventListener("click", signInWithEmail);
  elements.signOutButton.addEventListener("click", signOut);
  elements.startGameButton.addEventListener("click", joinRoom);
  elements.leaveRoomButton.addEventListener("click", async () => {
    await markOffline();
    returnToLobby();
  });
  elements.recenterButton.addEventListener("click", recenterMap);
  elements.closeBroadcastButton.addEventListener("click", closeBroadcastToast);

  elements.roomCode.addEventListener("change", (event) => {
    state.roomCode = cleanRoomCode(event.target.value);
    elements.roomCode.value = state.roomCode;
    state.room = null;
    state.players = [];
    state.hasPlayerRow = false;
    saveState();
    render();
  });

  elements.playerName.addEventListener("input", async (event) => {
    state.playerName = event.target.value.trim() || "玩家";
    saveState();
    await syncOwnPlayer(true);
    render();
  });

  window.addEventListener("beforeunload", markOfflineWithKeepalive);
  window.addEventListener("pagehide", markOfflineWithKeepalive);
  window.addEventListener("unload", markOfflineWithKeepalive);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncOwnPlayer(true);
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
  state.locationPermissionBlocked = false;
  bindLocationPermissionWatcher();

  state.watchId = navigator.geolocation.watchPosition(
    handlePrecisePosition,
    (error) => {
      if (error.code === 1) {
        disconnectForLocationOff();
      }
      const messages = {
        1: "定位授權被拒絕，請允許位置權限後再繼續。",
        2: "目前無法取得位置，請稍後重試。",
        3: "定位逾時，請再按一次允許定位。",
      };
      setLocationMessage(messages[error.code] || "定位失敗，請重試。");
      markLocationDisconnected();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    },
  );
}

async function handlePrecisePosition(position) {
  if (state.locationPermissionBlocked) return;
  if (!(await ensureLocationPermissionForSync())) return;

  const fix = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: Math.round(position.coords.accuracy),
    capturedAt: Date.now(),
  };

  state.locationGranted = true;
  state.usingMockLocation = false;
  state.lastLocationFixAt = fix.capturedAt;
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
  state.lastLocationFixAt = Date.now();
  saveState();
  setLocationMessage("目前使用模擬位置。");
  showNextAfterLocation();
  startLocationHeartbeat();
  syncOwnPlayer(true);
  render();
}

function startLocationHeartbeat() {
  if (state.heartbeatId !== null) return;
  state.heartbeatId = window.setInterval(async () => {
    if (document.visibilityState === "visible") {
      const permissionOk = await checkLocationPermissionStillGranted();
      if (!permissionOk) return;
      requestFreshLocationIfNeeded();
      syncOwnPlayer(false);
      pollRoomStatus(false);
    }
  }, LOCATION_SYNC_MS);
}

function startLocationPermissionMonitor() {
  if (state.permissionMonitorId !== null) return;
  state.permissionMonitorId = window.setInterval(() => {
    checkLocationPermissionStillGranted();
  }, LOCATION_SYNC_MS);
}

async function bindLocationPermissionWatcher() {
  if (state.usingMockLocation || state.locationPermissionStatusBound || !navigator.permissions?.query) return;

  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    state.locationPermissionStatusBound = true;
    permission.onchange = () => {
      if (permission.state === "denied") {
        disconnectForLocationOff();
      }
    };
    if (state.locationGranted && permission.state === "denied") {
      disconnectForLocationOff();
    }
  } catch {
    // Browsers without Permissions API still use watchPosition error handling.
  }
}

async function checkLocationPermissionStillGranted() {
  if (state.usingMockLocation || !navigator.permissions?.query) return true;
  if (!state.locationGranted && !state.hasPlayerRow) return true;
  if (state.permissionCheckInProgress) return true;

  state.permissionCheckInProgress = true;
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    if (!state.locationPermissionStatusBound) {
      state.locationPermissionStatusBound = true;
      permission.onchange = () => {
        if (permission.state === "denied") {
          state.locationPermissionBlocked = true;
          if (state.watchId !== null) {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
          }
          markLocationDisconnected();
          render();
        }
      };
    }
    if (permission.state === "denied") {
      await disconnectForLocationOff();
      render();
      return false;
    }
    return true;
  } catch {
    return true;
  } finally {
    state.permissionCheckInProgress = false;
  }
}

function requestFreshLocationIfNeeded() {
  if (state.usingMockLocation || state.locationRefreshInProgress || !("geolocation" in navigator)) return;
  if (!state.lastLocationFixAt || Date.now() - state.lastLocationFixAt < LOCATION_REFRESH_MS) return;

  state.locationRefreshInProgress = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.locationRefreshInProgress = false;
      handlePrecisePosition(position);
    },
    (error) => {
      state.locationRefreshInProgress = false;
      if (error.code === 1) {
        disconnectForLocationOff();
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 8000,
    },
  );
}

function showNextAfterLocation() {
  if (!state.locationGranted) return;
  if (["waiting", "game", "ended"].includes(state.phase)) return;

  if (!state.supabase || !state.session) {
    showView("auth");
    return;
  }

  showView("lobby");
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

  elements.emailSignInButton.disabled = true;
  setAuthMessage("正在登入...");
  const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
  elements.emailSignInButton.disabled = false;
  if (error) {
    setAuthMessage(error.message);
    return;
  }

  state.session = data.session;
  setAuthControls(Boolean(state.session));
  setAuthMessage("");
  if (state.locationGranted) {
    showView("lobby");
  }
  render();
}

async function signOut() {
  await markOffline();
  if (state.supabase) {
    await state.supabase.auth.signOut({ scope: "local" });
  }
  state.session = null;
  state.players = [];
  state.room = null;
  state.hasPlayerRow = false;
  state.team = "";
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

async function joinRoom() {
  if (state.joinInProgress) return;
  if (!state.session) {
    setLobbyMessage("請先登入。");
    showView("auth");
    return;
  }
  if (!state.position) {
    setLobbyMessage("請先允許定位。");
    showView("location");
    return;
  }

  const roomCode = cleanRoomCode(elements.roomCode.value);
  state.roomCode = roomCode;
  elements.roomCode.value = roomCode;
  state.playerName = elements.playerName.value.trim() || "玩家";
  saveState();

  state.joinInProgress = true;
  elements.startGameButton.disabled = true;

  try {
    setLobbyMessage("正在檢查房間...");
    const room = await loadRoom();
    if (!room) return;

    state.room = room;
    if (room.status === "ended") {
      setLobbyMessage("這個房間的遊戲已結束，請等待主持人建立新房間。");
      return;
    }

    if (room.status === "started") {
      const ownRecord = await loadOwnPlayerRecord();
      if (!ownRecord?.team) {
        setLobbyMessage("這個房間已經開始，未被主持人分隊的玩家不能加入。");
        return;
      }
      state.team = ownRecord.team;
      state.hasPlayerRow = true;
      await joinRealtimeRoom();
      await syncOwnPlayer(true);
      setLobbyMessage("");
      enterGame();
      return;
    }

    await joinRealtimeRoom();
    await loadRoomPlayers();
    state.team = "";
    await syncOwnPlayer(true);
    if (!state.hasPlayerRow) return;
    setLobbyMessage("");
    showWaiting();
    render();
  } catch (error) {
    setLobbyMessage(error.message || "加入房間失敗，請再試一次。");
  } finally {
    state.joinInProgress = false;
    elements.startGameButton.disabled = false;
  }
}

async function loadRoom() {
  if (!state.supabase || !state.session) return null;

  try {
    const rooms = await restRequest(
      `game_rooms?select=${ROOM_SELECT}&room_code=eq.${encodeURIComponent(state.roomCode)}&limit=1`,
      { method: "GET" },
      "檢查房間逾時，請再按一次加入房間。",
    );
    const room = Array.isArray(rooms) ? rooms[0] : null;
    if (!room) {
      setLobbyMessage("房間不存在，請確認主持人已建立房間，或房間代碼是否正確。");
      return null;
    }
    state.room = room;
    showBroadcastIfNeeded(room);
    return room;
  } catch (error) {
    setLobbyMessage(error.message || "檢查房間失敗，請再按一次加入房間。");
    return null;
  }

  const { data, error } = await withTimeout(
    state.supabase
      .from("game_rooms")
      .select(ROOM_SELECT)
      .eq("room_code", state.roomCode)
      .maybeSingle(),
    "檢查房間逾時，請再按一次加入房間。",
  );

  if (error) {
    setLobbyMessage(`${error.message}。請確認主持人已建立房間，且 Supabase schema 已更新。`);
    return null;
  }
  if (!data) {
    setLobbyMessage("房間不存在，請確認主持人已先建立這個房間代碼。");
    return null;
  }
  state.room = data;
  return data;
}

async function loadOwnPlayerRecord() {
  if (!state.supabase || !state.session) return null;

  const { data, error } = await withTimeout(
    state.supabase
      .from("game_players")
      .select("user_id,email,display_name,team,room_code,lat,lng,accuracy,is_online,updated_at")
      .eq("room_code", state.roomCode)
      .eq("user_id", state.session.user.id)
      .maybeSingle(),
    "讀取玩家資料逾時，請再按一次加入房間。",
  );

  if (error) {
    setLobbyMessage(error.message);
    return null;
  }

  if (data?.team) {
    state.team = data.team;
  }
  if (data) {
    state.hasPlayerRow = true;
  }
  return data ? fromDatabasePlayer(data) : null;
}

async function joinRealtimeRoom() {
  if (!state.supabase || !state.session) return;

  if (state.realtimeJoinPromise) {
    return state.realtimeJoinPromise;
  }

  if (state.realtimeChannel && state.realtimeRoomCode === state.roomCode) {
    return;
  }

  state.realtimeJoinPromise = (async () => {
    if (state.realtimeChannel) {
      state.supabase.removeChannel(state.realtimeChannel).catch(() => {});
      state.realtimeChannel = null;
      state.realtimeRoomCode = "";
    }

    const topic = `hide-seek-${state.roomCode}-${state.session.user.id}`;
    state.realtimeChannel = state.supabase
      .channel(topic)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "game_rooms",
          filter: `room_code=eq.${state.roomCode}`,
        },
        async (payload) => {
          applyRoomPayload(payload);
          await handleRoomStateChange();
          render();
        },
      )
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
          handleAssignedTeam();
          render();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          state.realtimeRoomCode = state.roomCode;
          setHudStatus("即時同步中");
        } else if (status === "CHANNEL_ERROR") {
          setHudStatus("使用輪詢同步中");
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

  const { data, error } = await withTimeout(
    state.supabase
      .from("game_players")
      .select("user_id,email,display_name,team,room_code,lat,lng,accuracy,is_online,updated_at")
      .eq("room_code", state.roomCode)
      .eq("is_online", true)
      .order("updated_at", { ascending: false }),
    "讀取玩家位置逾時。",
  );

  if (error) {
    setHudStatus(error.message);
    return;
  }

  state.players = data.map(fromDatabasePlayer);
  handleAssignedTeam();
}

function applyRoomPayload(payload) {
  if (payload.eventType === "DELETE") {
    state.room = null;
    return;
  }
  if (payload.new?.room_code) {
    state.room = payload.new;
    showBroadcastIfNeeded(payload.new);
  }
}

async function handleRoomStateChange() {
  if (state.room?.status === "ended") {
    showGameEnded();
    return;
  }

  if (state.room?.status === "started") {
    await loadRoomPlayers();
    const ownRecord = await loadOwnPlayerRecord();
    const ownPlayer = getOwnPlayer();
    const assignedTeam = ownRecord?.team || ownPlayer?.team || "";
    if (assignedTeam) {
      state.team = assignedTeam;
      enterGame();
    } else if (state.phase === "waiting") {
      setWaitingMessage("主持人已開始遊戲，但尚未分配到你的隊伍。");
    }
  }
}

async function pollRoomStatus(force) {
  if (!state.supabase || !state.session) return;
  if (!["waiting", "game"].includes(state.phase)) return;
  if (state.roomPollInProgress) return;
  if (!force && Date.now() - state.lastRoomPollAt < ROOM_STATUS_POLL_MS) return;

  state.roomPollInProgress = true;
  state.lastRoomPollAt = Date.now();
  try {
    const { data, error } = await withTimeout(
      state.supabase
        .from("game_rooms")
        .select(ROOM_SELECT)
        .eq("room_code", state.roomCode)
        .maybeSingle(),
      "檢查房間狀態逾時。",
    );

    if (error || !data) return;

    state.room = data;
    showBroadcastIfNeeded(data);
    if (data.status === "ended" || (data.status === "started" && state.phase === "waiting")) {
      await handleRoomStateChange();
      render();
    }
  } catch {
    // Background poll only backs up realtime; keep the current screen stable.
  } finally {
    state.roomPollInProgress = false;
  }
}

function handleAssignedTeam() {
  const ownPlayer = getOwnPlayer();
  if (ownPlayer) {
    state.hasPlayerRow = true;
  }
  if (ownPlayer?.team) {
    state.team = ownPlayer.team;
    if (state.room?.status === "started" && state.phase === "waiting") {
      enterGame();
    }
  }
}

function getOwnPlayer() {
  return state.players.find((player) => player.self);
}

function showWaiting() {
  elements.waitingRoomTitle.textContent = `${state.roomCode.toUpperCase()} 房間`;
  setWaitingMessage("已加入房間，請等待遊戲開始。");
  showView("waiting");
  pollRoomStatus(true);
}

function setWaitingMessage(message) {
  elements.waitingMessage.textContent = message;
}

function enterGame() {
  if (!state.team) return;
  showView("game");
  setTimeout(() => state.map.invalidateSize(), 50);
  recenterMap();
  syncOwnPlayer(true);
  pollRoomStatus(true);
  render();
}

function showGameEnded() {
  if (state.endRedirectTimer) {
    window.clearTimeout(state.endRedirectTimer);
  }
  state.players = [];
  state.team = "";
  state.room = null;
  state.hasPlayerRow = false;
  state.markers.forEach((marker) => marker.remove());
  state.markers.clear();
  showView("ended");
  state.endRedirectTimer = window.setTimeout(() => {
    returnToLobby();
  }, 3000);
}

function returnToLobby() {
  if (state.endRedirectTimer) {
    window.clearTimeout(state.endRedirectTimer);
    state.endRedirectTimer = null;
  }
  state.players = [];
  state.team = "";
  state.room = null;
  state.hasPlayerRow = false;
  showView("lobby");
  render();
}

function applyRealtimePayload(payload) {
  if (payload.eventType === "DELETE" && payload.old?.user_id) {
    state.players = state.players.filter((player) => player.userId !== payload.old.user_id);
    if (payload.old.user_id === state.session?.user?.id) {
      state.hasPlayerRow = false;
    }
    return;
  }

  if (!payload.new?.user_id) return;

  const next = fromDatabasePlayer(payload.new);
  const existingIndex = state.players.findIndex((player) => player.userId === next.userId);
  if (existingIndex >= 0) {
    state.players[existingIndex] = next;
  } else {
    state.players.push(next);
  }
  if (next.self && next.team) {
    state.team = next.team;
  }
  if (next.self) {
    state.hasPlayerRow = true;
  }
}

function fromDatabasePlayer(record) {
  const userId = record.user_id;
  return {
    id: userId,
    userId,
    email: record.email || "",
    name: record.display_name || record.email || "玩家",
    team: record.team || "",
    roomCode: record.room_code || state.roomCode,
    lat: record.lat === null || record.lat === undefined ? null : Number(record.lat),
    lng: record.lng === null || record.lng === undefined ? null : Number(record.lng),
    accuracy: record.accuracy || 0,
    isOnline: record.is_online !== false,
    updatedAt: record.updated_at,
    self: userId === state.session?.user?.id,
  };
}

function canSyncOwnPlayer() {
  if (!state.supabase || !state.session || !state.position || !state.room) return;
  if (state.room.room_code !== state.roomCode) return;
  if (state.room.status !== "lobby" && state.room.status !== "started") return;
  if (!state.joinInProgress && !["waiting", "game"].includes(state.phase)) return;
  if (document.visibilityState === "hidden") return;
  return true;
}

async function syncOwnPlayer(force) {
  if (!canSyncOwnPlayer()) return;
  if (!(await ensureLocationPermissionForSync())) return;

  if (state.syncPromise) {
    if (!force) return state.syncPromise.catch(() => {});
    await state.syncPromise.catch(() => {});
  }

  if (!canSyncOwnPlayer()) return;
  if (!(await ensureLocationPermissionForSync())) return;
  if (!force && Date.now() - state.lastSyncAt < LOCATION_SYNC_MS) return;

  state.syncInProgress = true;
  state.lastSyncAt = Date.now();
  state.syncPromise = (async () => {
    const user = state.session.user;
    const ownPlayer = getOwnPlayer();
    const assignedTeam = state.team || ownPlayer?.team || "";
    const payload = {
      user_id: user.id,
      email: user.email,
      display_name: state.playerName || getDisplayName(user),
      room_code: state.roomCode,
      lat: state.position.lat,
      lng: state.position.lng,
      accuracy: state.accuracy || null,
      is_online: true,
      updated_at: new Date().toISOString(),
    };

    if (state.room.status === "lobby" || assignedTeam) {
      payload.team = assignedTeam || null;
    }

    const query = state.hasPlayerRow
      ? state.supabase.from("game_players").update(payload).eq("user_id", user.id)
      : state.supabase.from("game_players").upsert(payload, {
          onConflict: "user_id",
        });

    const result = await withTimeout(query, "同步定位逾時，請再按一次加入房間。");

    const { error } = result;

    if (error) {
      setHudStatus(error.message);
      setLobbyMessage(error.message);
      return;
    }

    state.hasPlayerRow = true;
    applyRealtimePayload({ eventType: "UPDATE", new: payload });
    setHudStatus(`定位同步中 · ±${state.accuracy || "--"}m`);
  })();

  try {
    await state.syncPromise;
  } finally {
    state.syncPromise = null;
    state.syncInProgress = false;
  }
}

async function ensureLocationPermissionForSync() {
  if (state.usingMockLocation || !navigator.permissions?.query) return true;
  if (!state.locationGranted && !state.hasPlayerRow) return true;

  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    if (permission.state !== "denied") return true;
  } catch {
    return true;
  }

  state.locationPermissionBlocked = true;
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  await markLocationDisconnected();
  render();
  return false;
}

async function disconnectForLocationOff() {
  state.locationPermissionBlocked = true;
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  await markLocationDisconnected();
}

async function markOffline() {
  if (!state.supabase || !state.session) return;

  await state.supabase
    .from("game_players")
    .update({
      lat: null,
      lng: null,
      accuracy: null,
      is_online: false,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", state.session.user.id);
  state.hasPlayerRow = false;
}

async function markLocationDisconnected() {
  if (!state.supabase || !state.session) return;

  const payload = {
    lat: null,
    lng: null,
    accuracy: null,
    is_online: false,
    updated_at: new Date().toISOString(),
  };

  try {
    await state.supabase.from("game_players").update(payload).eq("user_id", state.session.user.id);
  } catch {
    // The control panel also marks stale heartbeats as disconnected.
  }

  state.hasPlayerRow = false;
  applyRealtimePayload({
    eventType: "UPDATE",
    new: {
      user_id: state.session.user.id,
      email: state.session.user.email,
      display_name: state.playerName || getDisplayName(state.session.user),
      team: state.team || null,
      room_code: state.roomCode,
      ...payload,
    },
  });
  setHudStatus("定位已關閉，主控台會顯示你已斷開連線。");
  render();
}

function markOfflineWithKeepalive() {
  if (!state.config.url || !state.config.anonKey || !state.session?.access_token) return;
  state.hasPlayerRow = false;

  const endpoint = `${state.config.url}/rest/v1/game_players?user_id=eq.${state.session.user.id}`;

  fetch(endpoint, {
    method: "PATCH",
    headers: {
      apikey: state.config.anonKey,
      authorization: `Bearer ${state.session.access_token}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({
      lat: null,
      lng: null,
      accuracy: null,
      is_online: false,
      updated_at: new Date().toISOString(),
    }),
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

function showBroadcastIfNeeded(room) {
  if (!room?.broadcast_message || !room.broadcast_at) return;
  if (room.broadcast_at === state.lastBroadcastAt) return;
  state.lastBroadcastAt = room.broadcast_at;
  elements.broadcastText.textContent = room.broadcast_message;
  elements.broadcastToast.classList.remove("hidden");
  saveState();
}

function closeBroadcastToast() {
  elements.broadcastToast.classList.add("hidden");
  if (state.room?.broadcast_at) {
    state.lastBroadcastAt = state.room.broadcast_at;
    saveState();
  }
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
  elements.teamBadge.textContent = state.team === "red" ? "紅隊" : state.team === "green" ? "綠隊" : "未分隊";
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
    const teamLabel = player.team === "red" ? "紅隊" : player.team === "green" ? "綠隊" : "未分隊";
    const onlineLabel = player.isOnline ? "在線" : "離線";
    return `
      <div class="player-row ${player.isOnline ? "" : "offline"}">
        <span class="player-dot ${player.team === "red" ? "red-dot" : player.team === "green" ? "green-dot" : "hidden-dot"}"></span>
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
  const players = getVisiblePlayers().filter(hasValidCoordinates);
  const visibleIds = new Set(players.map((player) => player.id));

  state.markers.forEach((marker, id) => {
    if (!visibleIds.has(id)) {
      marker.remove();
      state.markers.delete(id);
    }
  });

  players.forEach((player) => {
    const icon = L.divIcon({
      html: `<span class="custom-marker marker-${player.team || "waiting"}${player.self ? " marker-self" : ""}">${player.self ? "我" : player.team === "red" ? "紅" : player.team === "green" ? "綠" : "等"}</span>`,
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

function hasValidCoordinates(player) {
  return Number.isFinite(player.lat) && Number.isFinite(player.lng);
}

function getVisiblePlayers() {
  const players = getSameRoomPlayers();
  if (state.room?.status !== "started") {
    return players.filter((player) => player.self);
  }
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
  if (!Number.isFinite(player.lat) || !Number.isFinite(player.lng)) return false;
  if (!player.updatedAt) return false;
  const updatedAt = Date.parse(player.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= ACTIVE_PLAYER_MS;
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

function withTimeout(promise, message, timeoutMs = 20000) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const request = controller && typeof promise?.abortSignal === "function" ? promise.abortSignal(controller.signal) : promise;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      controller?.abort();
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([request, timeout]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

async function restRequest(path, options = {}, message = "連線逾時，請再試一次。", timeoutMs = 12000) {
  if (!state.config.url || !state.config.anonKey) throw new Error("Supabase 尚未設定。");
  if (!state.session?.access_token) throw new Error("請先登入。");

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${state.config.url}/rest/v1/${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: state.config.anonKey,
        authorization: `Bearer ${state.session.access_token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `Supabase 回應錯誤：${response.status}`);
    }

    if (response.status === 204) return null;
    return response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error(message);
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
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
