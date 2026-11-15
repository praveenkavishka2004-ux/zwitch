// ═══════════════════════════════════════════════════════════════════
//  ZWITCH — Smart Classroom Energy Dashboard  |  Team ZYNTRIX
//  Firebase Realtime Database  ⇄  ESP32 controller
// ═══════════════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getDatabase, ref, onValue, set } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

// ───────────────────────────────────────────────────────────────────
//  1) CONFIG — මෙතන විතරක් වෙනස් කළාම ඇති
// ───────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBDCP_3DT7WRJWerU2KF7ysFEC5izv-qxw",
  authDomain: "zintrix-7c221.firebaseapp.com",
  databaseURL: "https://zintrix-7c221-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "zintrix-7c221",
  storageBucket: "zintrix-7c221.firebasestorage.app",
  messagingSenderId: "984458930055",
  appId: "1:984458930055:web:a16623b5125beb45b59522",
  measurementId: "G-7EN3PNZ4V1"
};

/** Database එකේ rooms තියෙන root node */
const ROOMS_PATH = "rooms";

/** පළමු වරට dashboard එක open කරද්දි පෙන්වන rooms.
 *  deviceId = Firebase එකේ rooms/<deviceId> node එකේ නමම (ESP32 එක ලියන එක). */
const DEFAULT_ROOMS = [
  { name: "Demo Room", deviceId: "ZW-DEMO1" }
];

/** health/lastSeen මේ කාලයට වඩා පරණ නම් ESP32 එක Offline */
const OFFLINE_AFTER_MS = 60000;

const CO2_KG_PER_KWH = 0.77;
const KG_CO2_PER_TREE_YEAR = 20.6;

// ───────────────────────────────────────────────────────────────────
//  2) Firebase init
// ───────────────────────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ───────────────────────────────────────────────────────────────────
//  3) Helpers & storage
// ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const isTrue = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "on" || v === "occupied";
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const fmt = (v, d) => Number(num(v)).toFixed(d);
const pad2 = (n) => String(n).padStart(2, "0");
function dateKey(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function timeNow() { return new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

const TONE_TEXT = { green: "text-[#8CFF00]", yellow: "text-yellow-400", cyan: "text-cyan-400", red: "text-red-400", gray: "text-[#8C919F]" };
const TONE_BG   = { green: "bg-[#8CFF00]", yellow: "bg-yellow-400", cyan: "bg-cyan-400", red: "bg-red-400", gray: "bg-[#8C919F]" };
const TONE_HEX  = { green: "#8CFF00", yellow: "#facc15", cyan: "#22d3ee", red: "#f87171", gray: "#8C919F" };
const BADGE_TONE = {
  green:  "bg-[#8CFF00]/15 text-[#8CFF00] border-[#8CFF00]/20",
  yellow: "bg-yellow-400/15 text-yellow-400 border-yellow-400/20",
  cyan:   "bg-cyan-400/15 text-cyan-400 border-cyan-400/20",
  red:    "bg-red-400/15 text-red-400 border-red-400/20",
  gray:   "bg-[#8C919F]/15 text-[#8C919F] border-[#8C919F]/20",
};
const BADGE_BASE = "px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ";

function setTone(el, tone, kind = "text") {
  if (!el) return;
  const map = kind === "bg" ? TONE_BG : TONE_TEXT;
  Object.values(map).forEach((c) => el.classList.remove(c));
  el.classList.add(map[tone] || map.gray);
}
function setBadge(id, text, tone, base = BADGE_BASE) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.setAttribute("class", base + (BADGE_TONE[tone] || BADGE_TONE.gray));
}
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

// ───────────────────────────────────────────────────────────────────
//  4) State
// ───────────────────────────────────────────────────────────────────
let rooms = loadRooms();
let currentRoomId = localStorage.getItem("zwitch-active-room-id");
if (!rooms.some((r) => r.id === currentRoomId)) currentRoomId = rooms.length ? rooms[0].id : null;

let liveData = null;         // latest snapshot of rooms/<currentRoomId>
let liveStatus = "waiting";  // waiting | empty | ok
let prevEvents = {};         // for activity-log diffing
let unsubRoom = null;

const appConfig = Object.assign(
  { tariffRate: 35.0, lightDelay: 30, acDelay: 5 },
  lsGet("zwitch-config", {})
);

function newRoomObject(name, deviceId) {
  return {
    id: deviceId,
    name,
    deviceId,
    operationMode: "always",
    schedule: { startTime: "08:00", endTime: "18:00", days: "mon-fri" },
    logs: [],
  };
}
function loadRooms() {
  const saved = lsGet("zwitch-rooms-v2", null);
  if (Array.isArray(saved)) return saved;
  const seeded = DEFAULT_ROOMS.map((r) => newRoomObject(r.name, r.deviceId));
  lsSet("zwitch-rooms-v2", seeded);
  return seeded;
}
function saveRooms() { lsSet("zwitch-rooms-v2", rooms); }
function saveConfigLocal() { lsSet("zwitch-config", appConfig); }
function getActiveRoom() { return rooms.find((r) => r.id === currentRoomId) || null; }

// ───────────────────────────────────────────────────────────────────
//  5) Toast
// ───────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(title, message, type = "success") {
  const toast = $("globalToast");
  if (!toast) return;
  setText("toastTitle", title);
  setText("toastMsg", message);
  const icon = $("toastIcon");
  if (icon) {
    icon.textContent = type === "error" ? "✕" : "✓";
    icon.className = "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 " +
      (type === "error" ? "bg-red-400/10 text-red-400" : "bg-[#8CFF00]/10 text-[#8CFF00]");
  }
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() { $("globalToast")?.classList.add("hidden"); }
$("toastClose")?.addEventListener("click", hideToast);

// ───────────────────────────────────────────────────────────────────
//  6) Theme & mobile menu
// ───────────────────────────────────────────────────────────────────
let isDarkMode = localStorage.getItem("zwitch-theme") !== "light";

function applyTheme() {
  const body = $("appBody");
  body.classList.toggle("light-mode", !isDarkMode);
  body.classList.toggle("dark", isDarkMode);
  const knob = $("themeKnob");
  if (knob) knob.style.transform = isDarkMode ? "translateX(0)" : "translateX(calc(100% + 4px))";
  $("sunIcon")?.classList.toggle("hidden", isDarkMode);
  $("moonIcon")?.classList.toggle("hidden", !isDarkMode);
  setText("mobileThemeLabel", isDarkMode ? "Dark Theme" : "Light Theme");
  if (window.energyChartInstance) renderChart();
}
function toggleTheme() {
  isDarkMode = !isDarkMode;
  localStorage.setItem("zwitch-theme", isDarkMode ? "dark" : "light");
  applyTheme();
}
$("themeToggle")?.addEventListener("click", toggleTheme);
$("mobileThemeToggle")?.addEventListener("click", toggleTheme);

$("mobileMenuBtn")?.addEventListener("click", () => $("mobileNav").classList.toggle("hidden"));
$("mobileNav")?.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => $("mobileNav").classList.add("hidden")));

// ───────────────────────────────────────────────────────────────────
//  7) Activity log
// ───────────────────────────────────────────────────────────────────
const LOG_COLORS = {
  green: ["bg-[#8CFF00]/10", "bg-[#8CFF00]"], yellow: ["bg-yellow-400/10", "bg-yellow-400"],
  cyan: ["bg-cyan-400/10", "bg-cyan-400"], purple: ["bg-purple-400/10", "bg-purple-400"],
  red: ["bg-red-400/10", "bg-red-400"], gray: ["bg-[#8C919F]/10", "bg-[#8C919F]"],
};

function logEntryHtml(item) {
  const [bg, dot] = LOG_COLORS[item.color] || LOG_COLORS.green;
  return `
    <div class="w-8 h-8 rounded-lg ${bg} flex items-center justify-center flex-shrink-0 mt-0.5"><div class="w-2 h-2 rounded-full ${dot}"></div></div>
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium truncate">${escapeHtml(item.title)}</p>
      <p class="text-[10px] text-[#8C919F] mt-0.5">${escapeHtml(item.desc)}</p>
    </div>
    <span class="text-[10px] text-[#8C919F] flex-shrink-0">${escapeHtml(item.time || "")}</span>`;
}

function addLogEntry(title, desc, color = "green") {
  const room = getActiveRoom();
  if (!room) return;
  const item = { title, desc, color, time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) };
  room.logs = room.logs || [];
  room.logs.unshift(item);
  if (room.logs.length > 25) room.logs.pop();
  saveRooms();
  renderLogs();
}

function renderLogs() {
  const box = $("activityLog");
  if (!box) return;
  const room = getActiveRoom();
  box.innerHTML = "";
  if (!room || !room.logs || !room.logs.length) {
    box.innerHTML = '<div class="text-center py-8 text-xs text-[#8C919F]">No activity recorded yet.</div>';
    return;
  }
  room.logs.forEach((item) => {
    const d = document.createElement("div");
    d.className = "log-item flex items-start gap-3";
    d.innerHTML = logEntryHtml(item);
    box.appendChild(d);
  });
}

// ───────────────────────────────────────────────────────────────────
//  8) UI renderers (driven ONLY by Firebase data)
// ───────────────────────────────────────────────────────────────────
function noDataMessage() {
  if (!getActiveRoom()) return "Add a room to begin";
  return liveStatus === "empty" ? `No data at ${ROOMS_PATH}/${currentRoomId} yet` : "Waiting for data…";
}

function renderPresence(data) {
  const sensors = data && data.sensors;
  const has = sensors && sensors.presence !== undefined;
  const dot = $("presenceDot"), ping = $("presencePing");
  if (!has) {
    setBadge("presenceBadge", "—", "gray");
    setText("presenceStatus", "—");
    dot.style.backgroundColor = ping.style.backgroundColor = TONE_HEX.gray;
    ping.classList.remove("animate-ping");
    setText("presenceSubtext", noDataMessage());
    return;
  }
  const occupied = isTrue(sensors.presence);
  const tone = occupied ? "green" : "red";
  setBadge("presenceBadge", occupied ? "Occupied" : "Vacant", tone);
  setText("presenceStatus", occupied ? "Occupied" : "Vacant");
  dot.style.backgroundColor = ping.style.backgroundColor = TONE_HEX[tone];
  ping.classList.toggle("animate-ping", occupied);
  const extra = [];
  if (sensors.front !== undefined) extra.push(`Front: ${isTrue(sensors.front) ? "yes" : "no"}`);
  if (sensors.rear !== undefined) extra.push(`Rear: ${isTrue(sensors.rear) ? "yes" : "no"}`);
  setText("presenceSubtext", (occupied ? "Motion detected" : "No motion detected") + (extra.length ? " · " + extra.join(" · ") : ""));
}

function renderDevice(kind, value, onText, offText) {
  const has = value !== undefined && value !== null;
  const on = isTrue(value);
  const onTone = kind === "light" ? "yellow" : "cyan";
  const tone = !has ? "gray" : on ? onTone : "gray";
  setBadge(`${kind}Badge`, !has ? "—" : on ? "ON" : "OFF", tone);
  setText(`${kind}Status`, !has ? "—" : on ? "ON" : "OFF");
  $(`${kind}Dot`).style.backgroundColor = TONE_HEX[tone];
  setText(`${kind}Subtext`, !has ? noDataMessage() : on ? onText : offText);
}

function renderDevices(data) {
  const d = data && data.devices;
  renderDevice("light", d ? d.lights : undefined, "Classroom lights active", "Lights turned off");
  renderDevice("ac", d ? d.ac : undefined, "Cooling active", "A/C is off");
}

// Automation timeline
function setStep(n) {
  setText("timelineStepCounter", `Step ${n} / 5`);
  ["stepOccupied", "stepCountdown", "stepLightsOff", "stepVerifyAC", "stepStandby"].forEach((id, i) => {
    const el = $(id);
    if (!el) return;
    el.classList.remove("active", "completed");
    if (i + 1 < n) el.classList.add("completed");
    else if (i + 1 === n) el.classList.add("active");
  });
}

function setEngine(tone, label) {
  $("autoPulseDot").style.backgroundColor = TONE_HEX[tone];
  $("autoPulsePing").style.backgroundColor = TONE_HEX[tone];
  const pill = $("autoEnginePill");
  pill.textContent = label;
  pill.style.color = TONE_HEX[tone];
}

function stepFromAuto(a, presence) {
  const s = String(a.state || "").toUpperCase();
  if (num(a.countdownS) > 0) return 2;
  if (s.includes("OCCUP")) return 1;
  if (s.includes("COUNT") || s.includes("WAIT")) return 2;
  if (s.includes("CLEAN") || s.includes("STANDBY") || s.includes("ECO")) return 5;
  if (s.includes("LIGHT")) return 3;
  if (s.includes("VERIF") || s.includes("RETR") || s.includes("CHECK")) return 4;
  if (s.includes("VACANT")) return 2;
  return presence ? 1 : 5;
}

function setAcVerify(text, tone) {
  setBadge("acVerifyBadge", text, tone, "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ");
}

function renderAutomation(data) {
  const digits = $("countdownTimerDigits");
  const auto = data && data.auto;
  if (!auto) {
    setStep(1);
    setEngine("gray", "IDLE");
    setText("automationStateText", "Waiting…");
    setText("automationStateSubtext", noDataMessage());
    setText("countdownContext", "—");
    digits.textContent = "--:--";
    digits.className = "font-mono text-xl sm:text-2xl font-black text-[#8C919F] tracking-tight";
    setAcVerify("—", "gray");
    return;
  }

  const presence = isTrue(data.sensors && data.sensors.presence);
  const acOn = isTrue(data.devices && data.devices.ac);
  const secs = Math.max(0, Math.floor(num(auto.countdownS)));
  const step = stepFromAuto(auto, presence);
  const alarm = isTrue(auto.alarm);
  const retries = num(auto.retries);
  setStep(step);

  setText("automationStateText", String(auto.state || "—"));

  const subs = {
    1: "Occupied • sensing continuous presence",
    2: "No motion • countdown to shutdown",
    3: "Lights relay switching off",
    4: "A/C switched off • verifying power draw",
    5: "Zero idle draw verified • energy saved",
  };
  let sub = subs[step];
  if (retries > 0) sub += ` • retries: ${retries}`;
  if (alarm) sub = `ALARM — controller needs attention (retries: ${retries})`;
  setText("automationStateSubtext", sub);

  // Engine pill
  if (alarm) setEngine("red", "HALT");
  else if (step === 2) setEngine("yellow", "WAIT");
  else if (step === 3 || step === 4) setEngine("cyan", "EXEC");
  else setEngine("green", "LIVE");

  // Countdown
  if (secs > 0) {
    setText("countdownLabel", "Lights & A/C shutting down in:");
    setText("countdownContext", "Vacancy verified by radar");
    digits.textContent = `${Math.floor(secs / 60)}:${pad2(secs % 60)}`;
    digits.className = "font-mono text-xl sm:text-2xl font-black tracking-tight " +
      (secs <= 4 ? "text-red-400 animate-pulse" : secs <= 8 ? "text-amber-400" : "text-[#8CFF00]");
  } else if (step === 5) {
    setText("countdownLabel", "Room status:");
    setText("countdownContext", "Standby mode active");
    digits.textContent = "STANDBY";
    digits.className = "font-mono text-lg sm:text-xl font-bold text-[#8CFF00] tracking-tight";
  } else {
    setText("countdownLabel", "Next auto trigger:");
    setText("countdownContext", step === 1 ? "Awaiting vacancy" : "In progress");
    digits.textContent = step === 1 ? "--:--" : "…";
    digits.className = "font-mono text-xl sm:text-2xl font-black text-[#8CFF00] tracking-tight";
  }

  // A/C verification badge
  if (alarm) setAcVerify("Verification failed", "red");
  else if (step === 4) setAcVerify("Verifying current drop…", "cyan");
  else if (step === 5 && !acOn) setAcVerify("Switched off, verified", "green");
  else if (acOn) setAcVerify("Circuits Active", "green");
  else setAcVerify("A/C off", "gray");
}

function renderEnergy(data) {
  const live = data && data.energy && data.energy.live;
  if (!live) {
    ["ecoKwhSaved", "ecoCo2Saved", "ecoTreesSaved", "ecoCostSaved"].forEach((id) => setText(id, "0"));
    ["liveWatts", "liveVolts", "liveAmps", "liveKwh"].forEach((id) => setText(id, "—"));
    setBadge("pzemBadge", "PZEM —", "gray");
    return;
  }
  const saved = num(live.kwhSavedEst);
  const co2 = saved * CO2_KG_PER_KWH;
  setText("ecoKwhSaved", fmt(saved, 3));
  setText("ecoCo2Saved", fmt(co2, 3));
  setText("ecoTreesSaved", fmt(co2 / KG_CO2_PER_TREE_YEAR, 4));
  setText("ecoCostSaved", fmt(live.lkrSavedEst, 2));
  setText("liveWatts", fmt(live.watts, 0));
  setText("liveVolts", fmt(live.volts, 1));
  setText("liveAmps", fmt(live.amps, 2));
  setText("liveKwh", fmt(live.kwhMeasured, 3));
  const ok = live.pzemOk === undefined ? true : isTrue(live.pzemOk);
  setBadge("pzemBadge", ok ? "PZEM OK" : "PZEM Error", ok ? "green" : "red");
}

// Health
function lastSeenMs(data) {
  let v = data && data.health ? Number(data.health.lastSeen) : NaN;
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v > 1e11 ? v : v * 1000; // seconds → ms
}
function isDeviceOnline(data) {
  const t = lastSeenMs(data);
  return t > 0 && Date.now() - t < OFFLINE_AFTER_MS;
}

function setHealthRow(prefix, state) {
  const map = { online: ["Online", "green"], offline: ["Offline", "red"], unknown: ["—", "gray"] };
  const [text, tone] = map[state] || map.unknown;
  setText(`${prefix}HealthStatus`, text);
  setTone($(`${prefix}HealthStatus`), tone, "text");
  setTone($(`${prefix}HealthDot`), tone, "bg");
  $(`${prefix}HealthDot`)?.classList.toggle("animate-pulse", state === "online");
}

function renderHealth(data) {
  const h = data && data.health;
  if (!h) {
    ["esp", "sonoff", "acNode", "rear"].forEach((p) => setHealthRow(p, "unknown"));
    setBadge("healthSummary", "No data", "gray", "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ");
    setText("healthRssi", "—");
    setText("healthLastSeen", "—");
    return;
  }
  const online = isDeviceOnline(data);
  const flag = (v) => (!online ? "unknown" : isTrue(v) ? "online" : "offline");
  setHealthRow("esp", online ? "online" : "offline");
  setHealthRow("sonoff", flag(h.sonoffOnline));
  setHealthRow("acNode", flag(h.acNodeOnline));
  setHealthRow("rear", flag(h.rearOnline));

  const allOk = online && isTrue(h.sonoffOnline) && isTrue(h.acNodeOnline) && isTrue(h.rearOnline);
  const sumBase = "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ";
  if (!online) setBadge("healthSummary", "Device Offline", "red", sumBase);
  else if (allOk) setBadge("healthSummary", "All Normal", "green", sumBase);
  else setBadge("healthSummary", "Partial", "yellow", sumBase);

  setText("healthRssi", h.rssi !== undefined ? `${h.rssi} dBm` : "—");
  const t = lastSeenMs(data);
  setText("healthLastSeen", t ? new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
}

function renderRoomHeader() {
  const room = getActiveRoom();
  setText("activeRoomBadgeText", room ? room.name : "No Room");
  setText("activeDeviceId", room ? room.deviceId : "—");
  setText("healthDeviceId", room ? room.deviceId : "—");
  setText("overrideTargetRoom", room ? room.name : "No room selected");
  setText("mobileActiveRoomLabel", room ? `${room.name} • ${room.deviceId}` : "No room");
}

function renderAll() {
  renderRoomHeader();
  renderPresence(liveData);
  renderDevices(liveData);
  renderAutomation(liveData);
  renderEnergy(liveData);
  renderHealth(liveData);
  renderLogs();
  syncOperationModeUI();
  renderChart();
}

// ───────────────────────────────────────────────────────────────────
//  9) Firebase listeners
// ───────────────────────────────────────────────────────────────────
function subscribeToRoom(room) {
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  liveData = null;
  liveStatus = "waiting";
  prevEvents = {};
  if (!room) return;

  const roomId = room.id;
  const path = `${ROOMS_PATH}/${roomId}`;
  console.log(`[Zwitch] Listening to ${path}`);

  unsubRoom = onValue(
    ref(db, path),
    (snapshot) => {
      if (roomId !== currentRoomId) return; // stale
      const data = snapshot.val();
      liveData = data;
      liveStatus = data ? "ok" : "empty";
      setText("lastSync", timeNow());
      detectEvents(data);
      if (data) updateHistory(roomId, data);
      renderPresence(data);
      renderDevices(data);
      renderAutomation(data);
      renderEnergy(data);
      renderHealth(data);
      renderChart();
    },
    (err) => {
      console.error("[Zwitch] Firebase read error:", err);
      showToast("Firebase error", err.message + " — Database Rules බලන්න.", "error");
    }
  );
}

/** Compare new snapshot with previous one → activity log */
function detectEvents(data) {
  const cur = {
    presence: data && data.sensors && data.sensors.presence !== undefined ? isTrue(data.sensors.presence) : undefined,
    lights: data && data.devices ? data.devices.lights : undefined,
    ac: data && data.devices ? data.devices.ac : undefined,
    state: data && data.auto ? data.auto.state : undefined,
    alarm: data && data.auto ? isTrue(data.auto.alarm) : undefined,
    online: data && data.health ? isDeviceOnline(data) : undefined,
  };
  const p = prevEvents;
  const first = Object.keys(p).length === 0;
  if (first) {
    if (data) addLogEntry("Connected", `Streaming ${ROOMS_PATH}/${currentRoomId}`, "green");
  } else {
    if (cur.presence !== undefined && cur.presence !== p.presence)
      addLogEntry(cur.presence ? "Presence detected" : "Room vacant", cur.presence ? "Radar sensor triggered" : "No motion detected", cur.presence ? "green" : "red");
    if (cur.lights !== undefined && cur.lights !== p.lights)
      addLogEntry(`Lights ${isTrue(cur.lights) ? "ON" : "OFF"}`, "Relay state changed", isTrue(cur.lights) ? "yellow" : "gray");
    if (cur.ac !== undefined && cur.ac !== p.ac)
      addLogEntry(`A/C ${isTrue(cur.ac) ? "ON" : "OFF"}`, "Relay state changed", isTrue(cur.ac) ? "cyan" : "gray");
    if (cur.state !== undefined && cur.state !== p.state)
      addLogEntry(`Automation: ${cur.state}`, "State reported by controller", "purple");
    if (cur.alarm && !p.alarm)
      addLogEntry("ALARM raised", "Controller reported an alarm", "red");
  }
  prevEvents = Object.assign({}, p, cur);
}

// Re-check online/offline every 5s (no new snapshot arrives when the device goes silent)
setInterval(() => {
  if (!liveData || !liveData.health) return;
  const online = isDeviceOnline(liveData);
  if (prevEvents.online !== undefined && online !== prevEvents.online) {
    addLogEntry(online ? "Device online" : "Device offline", online ? "Heartbeat received" : "No heartbeat from ESP32", online ? "green" : "red");
  }
  prevEvents.online = online;
  renderHealth(liveData);
}, 5000);

// Firebase connection state
onValue(ref(db, ".info/connected"), (snap) => {
  const ok = snap.val() === true;
  const tone = ok ? "green" : "red";
  setText("firebaseHealthStatus", ok ? "Connected" : "Disconnected");
  setTone($("firebaseHealthStatus"), tone, "text");
  setTone($("firebaseHealthDot"), tone, "bg");
  setText("topLiveText", ok ? "LIVE" : "OFFLINE");
  [$("topLiveBadge"), $("topLiveDot")].forEach((el) => setTone(el, tone, "bg"));
  $("topLiveBadge")?.classList.toggle("animate-ping", ok);
});

// ───────────────────────────────────────────────────────────────────
//  10) Device control  →  rooms/<id>/devices/<lights|ac> = "on" | "off"
// ───────────────────────────────────────────────────────────────────
function controlDevice(device, command) {
  const room = getActiveRoom();
  if (!room) { showToast("No room selected", "Add a room first.", "error"); return; }
  const label = device === "lights" ? "Lights" : "A/C";
  set(ref(db, `${ROOMS_PATH}/${room.id}/devices/${device}`), command)
    .then(() => showToast("Command Sent", `${room.name}: ${label} → ${command.toUpperCase()}`))
    .catch((err) => {
      console.error("[Zwitch] write failed:", err);
      showToast("Error", `Could not send command: ${err.message}`, "error");
    });
}
document.querySelectorAll("[data-device]").forEach((btn) =>
  btn.addEventListener("click", () => controlDevice(btn.dataset.device, btn.dataset.cmd))
);

// ───────────────────────────────────────────────────────────────────
//  11) Operation mode, schedule & system configuration
//      (saved to rooms/<id>/config so the ESP32 can read it if needed)
// ───────────────────────────────────────────────────────────────────
function pushConfig(room) {
  if (!room) return Promise.resolve();
  const payload = {
    operationMode: room.operationMode || "always",
    schedule: room.schedule || { startTime: "08:00", endTime: "18:00", days: "mon-fri" },
    lightOffDelayS: appConfig.lightDelay,
    acOffDelayMin: appConfig.acDelay,
    tariffLkrPerKwh: appConfig.tariffRate,
  };
  return set(ref(db, `${ROOMS_PATH}/${room.id}/config`), payload);
}

function syncOperationModeUI() {
  const room = getActiveRoom();
  const always = $("modeBtnAlways"), sched = $("modeBtnSchedule");
  const sc = room && room.schedule ? room.schedule : { startTime: "08:00", endTime: "18:00", days: "mon-fri" };
  $("scheduleStartTime").value = sc.startTime;
  $("scheduleEndTime").value = sc.endTime;
  $("scheduleDaysSelect").value = sc.days;

  const isSched = room && room.operationMode === "schedule";
  always.classList.toggle("active", !isSched);
  always.classList.toggle("text-[#8C919F]", !!isSched);
  sched.classList.toggle("active", !!isSched);
  sched.classList.toggle("text-[#8C919F]", !isSched);
  $("scheduleConfigContainer").classList.toggle("hidden", !isSched);
  setText("modeStatusPillText", !room ? "No room" : isSched ? `Schedule: ${sc.startTime} — ${sc.endTime}` : "Always Active");
}

function setMode(mode) {
  const room = getActiveRoom();
  if (!room) { showToast("No room selected", "Add a room first.", "error"); return; }
  room.operationMode = mode;
  saveRooms();
  syncOperationModeUI();
  pushConfig(room)
    .then(() => showToast("Mode Changed", `${room.name}: ${mode === "always" ? "Always Active (24/7)" : "Schedule Based"}`))
    .catch((e) => showToast("Saved locally only", e.message, "error"));
  addLogEntry("Mode changed", mode === "always" ? "Always Active (24/7)" : "Schedule Based", "cyan");
}
$("modeBtnAlways")?.addEventListener("click", () => setMode("always"));
$("modeBtnSchedule")?.addEventListener("click", () => setMode("schedule"));

$("btnSaveSchedule")?.addEventListener("click", () => {
  const room = getActiveRoom();
  if (!room) { showToast("No room selected", "Add a room first.", "error"); return; }
  room.schedule = {
    startTime: $("scheduleStartTime").value || "08:00",
    endTime: $("scheduleEndTime").value || "18:00",
    days: $("scheduleDaysSelect").value,
  };
  room.operationMode = "schedule";
  saveRooms();
  syncOperationModeUI();
  pushConfig(room)
    .then(() => showToast("Schedule Saved", `${room.name}: ${room.schedule.startTime} — ${room.schedule.endTime}`))
    .catch((e) => showToast("Saved locally only", e.message, "error"));
  addLogEntry("Schedule updated", `${room.schedule.startTime} — ${room.schedule.endTime} (${room.schedule.days})`, "purple");
});

function syncSystemConfigUI() {
  $("cfgTariffRate").value = Number(appConfig.tariffRate).toFixed(1);
  $("cfgLightDelay").value = appConfig.lightDelay;
  $("cfgAcDelay").value = appConfig.acDelay;
  setText("lightDelayVal", `${appConfig.lightDelay}s`);
  setText("acDelayVal", `${appConfig.acDelay} min`);
}
$("cfgLightDelay")?.addEventListener("input", (e) => setText("lightDelayVal", `${e.target.value}s`));
$("cfgAcDelay")?.addEventListener("input", (e) => setText("acDelayVal", `${e.target.value} min`));

$("systemConfigForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  appConfig.tariffRate = parseFloat($("cfgTariffRate").value) || 35.0;
  appConfig.lightDelay = parseInt($("cfgLightDelay").value, 10) || 30;
  appConfig.acDelay = parseInt($("cfgAcDelay").value, 10) || 5;
  saveConfigLocal();
  const room = getActiveRoom();
  pushConfig(room)
    .then(() => showToast("Settings Saved", `Tariff ${appConfig.tariffRate} LKR/kWh • delays ${appConfig.lightDelay}s / ${appConfig.acDelay}m`))
    .catch((err) => showToast("Saved locally only", err.message, "error"));
  if (room) addLogEntry("Settings saved", `Light delay ${appConfig.lightDelay}s, A/C delay ${appConfig.acDelay}m`, "green");
});

// ───────────────────────────────────────────────────────────────────
//  12) Energy history (stored in this browser) + chart
// ───────────────────────────────────────────────────────────────────
function updateHistory(roomId, data) {
  const live = data.energy && data.energy.live;
  if (!live) return;
  const all = lsGet("zwitch-history-v1", {});
  const h = all[roomId] || { days: {}, prev: null };
  const m = num(live.kwhMeasured), s = num(live.kwhSavedEst);
  if (h.prev) {
    const dm = m >= h.prev.m ? m - h.prev.m : m;  // counter reset → count from 0
    const ds = s >= h.prev.s ? s - h.prev.s : s;
    if (dm > 0 || ds > 0) {
      const k = dateKey();
      const day = h.days[k] || { used: 0, saved: 0 };
      day.used += dm;
      day.saved += ds;
      h.days[k] = day;
    }
  }
  h.prev = { m, s };
  // keep ~90 days
  const keys = Object.keys(h.days).sort();
  while (keys.length > 90) delete h.days[keys.shift()];
  all[roomId] = h;
  lsSet("zwitch-history-v1", all);
}

function getDays(roomId, count) {
  const h = (lsGet("zwitch-history-v1", {})[roomId] || {}).days || {};
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = dateKey(d);
    const rec = h[k] || { used: 0, saved: 0 };
    out.push({ date: d, key: k, used: rec.used, saved: rec.saved });
  }
  return out;
}

function chartPeriod() {
  const b = document.querySelector(".chart-period-btn.active");
  return b ? b.dataset.period : "week";
}

function renderChart() {
  const canvas = $("energyChart");
  if (!canvas || typeof Chart === "undefined") return;
  const room = getActiveRoom();
  const period = chartPeriod();
  let labels = [], used = [], base = [];

  if (room) {
    if (period === "month") {
      const days = getDays(room.id, 28);
      for (let w = 0; w < 4; w++) {
        const chunk = days.slice(w * 7, w * 7 + 7);
        const u = chunk.reduce((a, d) => a + d.used, 0);
        const s = chunk.reduce((a, d) => a + d.saved, 0);
        labels.push(w === 3 ? "This week" : `${3 - w} wk ago`);
        used.push(+u.toFixed(4));
        base.push(+(u + s).toFixed(4));
      }
    } else {
      getDays(room.id, 7).forEach((d) => {
        labels.push(d.date.toLocaleDateString("en-US", { weekday: "short" }));
        used.push(+d.used.toFixed(4));
        base.push(+(d.used + d.saved).toFixed(4));
      });
    }
  } else {
    labels = period === "month" ? ["W1", "W2", "W3", "W4"] : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    used = labels.map(() => 0);
    base = labels.map(() => 0);
  }
  setText("chartSubtitle", period === "month" ? "kWh per week (last 4 weeks)" : "kWh per day (last 7 days)");

  if (window.energyChartInstance) window.energyChartInstance.destroy();
  const grid = isDarkMode ? "rgba(38,41,51,0.8)" : "rgba(229,231,235,0.8)";
  const tick = isDarkMode ? "#8C919F" : "#6b7280";

  window.energyChartInstance = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Actual (kWh)", data: used, backgroundColor: "rgba(140,255,0,0.7)", borderColor: "#8CFF00", borderWidth: 1, borderRadius: 6, borderSkipped: false, barPercentage: 0.6, categoryPercentage: 0.7 },
        { label: "Without automation (kWh)", data: base, type: "line", borderColor: isDarkMode ? "rgba(140,145,159,0.6)" : "rgba(107,114,128,0.6)", borderDash: [6, 4], borderWidth: 2, pointRadius: 0, fill: false, tension: 0 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { position: "top", align: "end", labels: { color: tick, font: { size: 11, family: "Inter" }, usePointStyle: true, padding: 20 } },
        tooltip: {
          backgroundColor: isDarkMode ? "#181A20" : "#ffffff",
          titleColor: isDarkMode ? "#ffffff" : "#1a1a2e",
          bodyColor: isDarkMode ? "#8C919F" : "#6b7280",
          borderColor: isDarkMode ? "#262933" : "#e5e7eb",
          borderWidth: 1, cornerRadius: 10, padding: 12,
          callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(3)} kWh` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: tick, font: { size: 11, family: "Inter" } }, border: { display: false } },
        y: { beginAtZero: true, grid: { color: grid, drawTicks: false }, ticks: { color: tick, font: { size: 11, family: "Inter" }, padding: 8, callback: (v) => v + " kWh" }, border: { display: false } },
      },
    },
  });
}

document.querySelectorAll(".chart-period-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chart-period-btn").forEach((b) => {
      b.classList.remove("active", "bg-[#262933]", "text-white");
      b.classList.add("text-[#8C919F]");
    });
    btn.classList.add("active", "bg-[#262933]", "text-white");
    btn.classList.remove("text-[#8C919F]");
    renderChart();
  })
);

// ───────────────────────────────────────────────────────────────────
//  13) Reports (CSV / PDF)
// ───────────────────────────────────────────────────────────────────
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
const stamp = () => dateKey().replace(/-/g, "");

function buildCsv(type, room) {
  let days;
  if (type === "monthly") {
    const now = new Date();
    days = getDays(room.id, now.getDate()).filter((d) => d.date.getMonth() === now.getMonth());
  } else {
    days = getDays(room.id, 7);
  }
  const rate = num(appConfig.tariffRate, 35);
  let csv = "Room,Device ID,Date,Energy Used (kWh),Estimated Saved (kWh),Baseline (kWh),Cost Saved (LKR)\n";
  days.forEach((d) => {
    csv += `"${room.name}","${room.deviceId}",${d.key},${d.used.toFixed(4)},${d.saved.toFixed(4)},${(d.used + d.saved).toFixed(4)},${(d.saved * rate).toFixed(2)}\n`;
  });
  return csv;
}

function buildPdf(room) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const live = (liveData && liveData.energy && liveData.energy.live) || {};
  const days = getDays(room.id, 7);
  const totalUsed = days.reduce((a, d) => a + d.used, 0);
  const totalSaved = days.reduce((a, d) => a + d.saved, 0);
  const peak = Math.max(0, ...days.map((d) => d.used));
  const auto = (liveData && liveData.auto) || {};
  const presence = liveData && liveData.sensors ? (isTrue(liveData.sensors.presence) ? "Occupied" : "Vacant") : "n/a";

  let y = 20;
  const line = (text, size = 11, bold = false, gap = 8) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.text(text, 20, y);
    y += gap;
  };
  line("ZWITCH - Energy Consumption Report", 18, true, 8);
  line("Team ZYNTRIX - Project Zwitch", 11, false, 10);
  line(`Classroom: ${room.name} (${room.deviceId})`);
  line(`Generated: ${new Date().toLocaleString()}`, 11, false, 12);

  line("Last 7 Days (recorded by this dashboard)", 14, true, 9);
  line(`Total consumption: ${totalUsed.toFixed(3)} kWh`);
  line(`Estimated saved: ${totalSaved.toFixed(3)} kWh`);
  line(`Baseline (no automation): ${(totalUsed + totalSaved).toFixed(3)} kWh`);
  line(`Peak day: ${peak.toFixed(3)} kWh`, 11, false, 12);

  line("Live Readings", 14, true, 9);
  line(`Power: ${fmt(live.watts, 0)} W   Voltage: ${fmt(live.volts, 1)} V   Current: ${fmt(live.amps, 2)} A`);
  line(`Total measured: ${fmt(live.kwhMeasured, 3)} kWh`);
  line(`Saved (controller estimate): ${fmt(live.kwhSavedEst, 4)} kWh = ${fmt(live.lkrSavedEst, 2)} LKR`);
  line(`CO2 prevented: ${(num(live.kwhSavedEst) * CO2_KG_PER_KWH).toFixed(3)} kg`, 11, false, 12);

  line("Automation Status", 14, true, 9);
  line(`Presence: ${presence}`);
  line(`State: ${auto.state || "n/a"}   Retries: ${num(auto.retries)}   Alarm: ${isTrue(auto.alarm) ? "YES" : "no"}`);

  doc.setFontSize(9);
  doc.setTextColor(150);
  doc.text("(c) 2026 Team ZYNTRIX. All Rights Reserved.", 20, 285);
  doc.save(`zwitch_${room.id}_summary_${stamp()}.pdf`);
}

function downloadReport(type, format) {
  const room = getActiveRoom();
  if (!room) { showToast("No room selected", "Add a room first.", "error"); return; }
  try {
    if (format === "csv") {
      downloadBlob(buildCsv(type, room), `zwitch_${room.id}_${type}_${stamp()}.csv`, "text/csv;charset=utf-8;");
    } else {
      if (!window.jspdf) throw new Error("PDF library not loaded");
      buildPdf(room);
    }
    showToast("Download Started", `${type} ${format.toUpperCase()} report for ${room.name}`);
  } catch (err) {
    showToast("Report error", err.message, "error");
  }
}
document.querySelectorAll("[data-report]").forEach((btn) =>
  btn.addEventListener("click", () => downloadReport(btn.dataset.report, btn.dataset.format))
);

// ───────────────────────────────────────────────────────────────────
//  14) Rooms: selector, switching, add / edit / remove
// ───────────────────────────────────────────────────────────────────
function populateRoomSelectors() {
  const sel = $("roomSelector");
  sel.innerHTML = "";
  if (!rooms.length) {
    const o = document.createElement("option");
    o.textContent = "No rooms — click Add Room";
    o.value = ""; o.disabled = true; o.selected = true;
    sel.appendChild(o);
  } else {
    rooms.forEach((r) => {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = `${r.name} (${r.deviceId})`;
      o.selected = r.id === currentRoomId;
      sel.appendChild(o);
    });
  }

  const list = $("mobileRoomList");
  list.innerHTML = "";
  if (!rooms.length) {
    list.innerHTML = '<span class="text-[10px] text-[#8C919F]">No rooms added yet</span>';
  } else {
    rooms.forEach((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "px-3 py-1.5 rounded-lg text-xs font-medium transition-all " +
        (r.id === currentRoomId ? "bg-[#8CFF00] text-[#0E0F12] font-semibold" : "bg-[#262933] text-[#8C919F] hover:text-white");
      b.textContent = r.name;
      b.addEventListener("click", () => { switchRoom(r.id); $("mobileNav").classList.add("hidden"); });
      list.appendChild(b);
    });
  }
}

function switchRoom(roomId, silent = false) {
  currentRoomId = roomId;
  if (roomId) localStorage.setItem("zwitch-active-room-id", roomId);
  else localStorage.removeItem("zwitch-active-room-id");
  populateRoomSelectors();
  subscribeToRoom(getActiveRoom());
  setText("lastSync", "—");
  renderAll();
  document.querySelectorAll(".dashboard-card").forEach((c) => {
    c.classList.remove("card-refresh"); void c.offsetWidth; c.classList.add("card-refresh");
  });
  const room = getActiveRoom();
  if (room && !silent) showToast("Room Switched", `Now monitoring ${room.name} (${room.deviceId})`);
}
$("roomSelector")?.addEventListener("change", (e) => e.target.value && switchRoom(e.target.value));

// Modals
function openModal(id) {
  const m = $(id);
  m.classList.remove("hidden"); m.classList.add("flex");
  document.body.style.overflow = "hidden";
}
function closeModal(id) {
  const m = $(id);
  m.classList.add("hidden"); m.classList.remove("flex");
  document.body.style.overflow = "";
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal("addRoomModal"); closeModal("manageRoomModal"); }
});

// Add room
function openAddRoom() {
  $("addRoomForm").reset();
  $("roomNameError").classList.add("hidden");
  $("deviceIdError").classList.add("hidden");
  openModal("addRoomModal");
  setTimeout(() => $("newRoomName").focus(), 80);
}
$("openAddRoomModalBtn")?.addEventListener("click", openAddRoom);
["closeAddRoomModalBtn", "cancelAddRoomBtn", "modalBackdrop"].forEach((id) => $(id)?.addEventListener("click", () => closeModal("addRoomModal")));

$("addRoomForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("newRoomName").value.trim();
  const deviceId = $("newDeviceId").value.trim();
  let bad = false;

  $("roomNameError").classList.toggle("hidden", !!name);
  if (!name) bad = true;

  const errEl = $("deviceIdError");
  let msg = "";
  if (!deviceId) msg = "Please enter the Device ID.";
  else if (/[.#$\[\]\/\s]/.test(deviceId)) msg = "Device ID cannot contain spaces or . # $ [ ] /";
  else if (rooms.some((r) => r.id === deviceId)) msg = "This Device ID is already added.";
  errEl.textContent = msg;
  errEl.classList.toggle("hidden", !msg);
  if (msg) bad = true;
  if (bad) return;

  rooms.push(newRoomObject(name, deviceId));
  saveRooms();
  closeModal("addRoomModal");
  switchRoom(deviceId, true);
  showToast("Room Added", `${name} → ${ROOMS_PATH}/${deviceId}`);
});

// Manage room
$("openManageRoomModalBtn")?.addEventListener("click", () => {
  const room = getActiveRoom();
  if (!room) { showToast("No room selected", "Add a room first.", "error"); return; }
  $("editRoomName").value = room.name;
  setText("manageDeviceIdDisplay", room.deviceId);
  $("editRoomNameError").classList.add("hidden");
  openModal("manageRoomModal");
  setTimeout(() => { $("editRoomName").focus(); $("editRoomName").select(); }, 80);
});
["closeManageRoomModalBtn", "cancelManageRoomBtn", "manageModalBackdrop"].forEach((id) => $(id)?.addEventListener("click", () => closeModal("manageRoomModal")));

$("manageRoomForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("editRoomName").value.trim();
  $("editRoomNameError").classList.toggle("hidden", !!name);
  if (!name) return;
  const room = getActiveRoom();
  const old = room.name;
  room.name = name;
  saveRooms();
  populateRoomSelectors();
  renderRoomHeader();
  closeModal("manageRoomModal");
  showToast("Room Updated", `Renamed "${old}" to "${name}".`);
});

$("btnDeleteRoom")?.addEventListener("click", () => {
  const room = getActiveRoom();
  if (!room) return;
  if (!confirm(`Remove "${room.name}" from this dashboard?\n(Data in Firebase is not deleted.)`)) return;
  const idx = rooms.findIndex((r) => r.id === room.id);
  rooms.splice(idx, 1);
  saveRooms();
  closeModal("manageRoomModal");
  const next = rooms[Math.min(idx, rooms.length - 1)];
  switchRoom(next ? next.id : null, true);
  showToast("Room Removed", `"${room.name}" removed from the dashboard.`);
});

// ───────────────────────────────────────────────────────────────────
//  15) Init
// ───────────────────────────────────────────────────────────────────
applyTheme();
setText("monthLabel", new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }));
syncSystemConfigUI();
populateRoomSelectors();
subscribeToRoom(getActiveRoom());
renderAll();
