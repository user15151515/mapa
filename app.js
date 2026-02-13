import { db, storage, fs, st, auth, ensureSignedIn } from "./firebase.js";
import { compressImage, formatDateISO, monthKeyFromISO, toast, safeText, stars, debounce } from "./utils.js";

/**
 * Data model (Firestore):
 * - stats/global: { totalVisits: number, updatedAt }
 * - places/{placeId}: { name, mapsUrl?, lat?, lng?, visitsCount, lastVisitedISO, createdAt }
 * - visits/{visitId}: { dateISO, placeId, placeName, notes, rating, photoPath, photoURL, createdAt }
 *
 * Storage:
 * - visits/{visitId}.jpg
 */

const el = (id) => document.getElementById(id);

const state = {
  user: null,
  places: [],
  visits: [],
  filteredVisits: [],
  selectedPlaceId: "",
  searchText: "",
  map: null,
  markers: new Map(), // placeId -> marker
  calendarMonth: new Date(), // active month view
  viewVisit: null,
  newPlaceMode: false,
  selectedPhotoFile: null,
  selectedPhotoBlob: null,
  selectedPhotoPreviewURL: null,
};

// ---------- Init ----------
init().catch((e) => {
  console.error(e);
  toast("Init failed — check Firebase config & console.");
});

async function init() {
  wireUI();

  // Sign in (anonymous)
  state.user = await ensureSignedIn();
  // Start listeners
  listenStats();
  listenPlaces();
  listenVisits();

  // Leaflet map init
  initMap();

  // Default date in form: today
  el("visitDate").value = isoToday();

  // Calendar init
  state.calendarMonth = new Date();
  renderCalendar();
}

function wireUI() {
  // Tabs
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // Buttons
  el("btnNewVisit").addEventListener("click", openModal);
  el("btnCloseModal").addEventListener("click", closeModal);
  el("btnCloseView").addEventListener("click", closeViewModal);
  el("btnRefresh").addEventListener("click", () => { toast("Refreshing…"); });

  document.querySelectorAll("[data-close]").forEach((x) => x.addEventListener("click", (ev) => {
    const t = ev.currentTarget.getAttribute("data-close");
    if (t === "1") closeModal();
    if (t === "2") closeViewModal();
  }));

  // New place toggle
  el("btnToggleNewPlace").addEventListener("click", () => {
    state.newPlaceMode = !state.newPlaceMode;
    el("newPlaceBox").hidden = !state.newPlaceMode;
    el("btnToggleNewPlace").textContent = state.newPlaceMode ? "Use existing" : "+ New";
  });

  // Photo input
  el("photoInput").addEventListener("change", onPhotoPicked);
  el("btnRemovePhoto").addEventListener("click", clearPhoto);

  // Form submit
  el("visitForm").addEventListener("submit", onSubmitVisit);

  // Search / filter
  el("placeFilter").addEventListener("change", () => {
    state.selectedPlaceId = el("placeFilter").value;
    applyFilters();
  });

  el("searchInput").addEventListener("input", debounce(() => {
    state.searchText = el("searchInput").value.trim().toLowerCase();
    applyFilters();
  }, 180));

  // Map
  el("btnFitMap").addEventListener("click", fitMapToMarkers);

  // Calendar controls
  el("btnPrevMonth").addEventListener("click", () => shiftMonth(-1));
  el("btnNextMonth").addEventListener("click", () => shiftMonth(1));
  el("btnToday").addEventListener("click", () => { state.calendarMonth = new Date(); renderCalendar(); });

  // View modal filter
  el("btnFilterThisPlace").addEventListener("click", () => {
    if (!state.viewVisit?.placeId) return;
    state.selectedPlaceId = state.viewVisit.placeId;
    el("placeFilter").value = state.selectedPlaceId;
    switchTab("history");
    applyFilters();
    closeViewModal();
  });
}

// ---------- Firestore listeners ----------
function listenStats() {
  const statsRef = fs.doc(db, "stats", "global");
  fs.onSnapshot(statsRef, async (snap) => {
    if (!snap.exists()) {
      await fs.setDoc(statsRef, { totalVisits: 0, updatedAt: fs.serverTimestamp() }, { merge: true });
      el("totalVisits").textContent = "0";
      return;
    }
    const data = snap.data();
    el("totalVisits").textContent = String(data.totalVisits ?? 0);
  });
}

function listenPlaces() {
  const q = fs.query(fs.collection(db, "places"), fs.orderBy("visitsCount", "desc"));
  fs.onSnapshot(q, (snap) => {
    state.places = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPlacesUI();
    renderPlaceDropdowns();
    refreshMapMarkers();
    computeTopPlace();
  });
}

function listenVisits() {
  // newest first
  const q = fs.query(fs.collection(db, "visits"), fs.orderBy("dateISO", "desc"), fs.limit(200));
  fs.onSnapshot(q, (snap) => {
    state.visits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    applyFilters();
    computeMonthStats();
    computeStreak();
    renderCalendar(); // calendar depends on visits
    renderTimeline();
  });
}

// ---------- UI rendering ----------
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));

  const idx = ["history","map","calendar"].indexOf(tab);
  const underline = document.querySelector(".tab-underline");
  underline.style.transform = `translateX(${idx * 100}%)`;

  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  el(`panel-${tab}`).classList.add("active");

  // map needs resize when revealed
  if (tab === "map" && state.map) setTimeout(() => state.map.invalidateSize(), 100);
}

function renderPlaceDropdowns() {
  const sel = el("visitPlaceSelect");
  const filter = el("placeFilter");

  // visit modal select
  const prevSel = sel.value;
  sel.innerHTML = `<option value="">Select existing…</option>`;
  for (const p of state.places) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = prevSel;

  // filter select
  const prevFilter = filter.value;
  filter.innerHTML = `<option value="">All places</option>`;
  for (const p of state.places) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    filter.appendChild(opt);
  }
  filter.value = state.selectedPlaceId || prevFilter || "";
}

function renderPlacesUI() {
  const wrap = el("placesList");
  wrap.innerHTML = "";

  const visitedIds = new Set(state.visits.map(v => v.placeId).filter(Boolean));

  for (const p of state.places) {
    const item = document.createElement("div");
    item.className = "place-item";
    const visited = visitedIds.has(p.id);
    const last = p.lastVisitedISO ? formatDateISO(p.lastVisitedISO) : "—";

    item.innerHTML = `
      <div class="place-left">
        <div class="place-name">${escapeHTML(p.name)}</div>
        <div class="place-sub">${visited ? "Visited" : "Not visited"} • last: ${last}</div>
      </div>
      <div class="place-right">
        <span class="pill">${Number(p.visitsCount || 0)} visits</span>
        <span>${visited ? "✅" : "⭕"}</span>
      </div>
    `;

    item.addEventListener("click", () => {
      state.selectedPlaceId = p.id;
      el("placeFilter").value = p.id;
      switchTab("history");
      applyFilters();
      toast(`Filtered: ${p.name}`);
    });

    wrap.appendChild(item);
  }
}

function applyFilters() {
  const pid = state.selectedPlaceId;
  const s = state.searchText;

  state.filteredVisits = state.visits.filter(v => {
    if (pid && v.placeId !== pid) return false;
    if (!s) return true;
    const hay = `${v.placeName || ""} ${v.notes || ""}`.toLowerCase();
    return hay.includes(s);
  });

  renderHistory();
}

function renderHistory() {
  const list = el("visitList");
  list.innerHTML = "";

  const items = state.filteredVisits;
  el("emptyHistory").hidden = items.length !== 0;

  for (const v of items) {
    const card = document.createElement("div");
    card.className = "visit-card";
    card.innerHTML = `
      <img class="thumb" src="${escapeAttr(photoSrc(v))}"
" alt="Visit photo" loading="lazy" />
      <div class="visit-meta">
        <div class="row1">
          <div class="place">${escapeHTML(v.placeName || "Unknown place")}</div>
          <div class="date">${formatDateISO(v.dateISO)}</div>
        </div>
        <div class="notes">${escapeHTML(v.notes || "No notes")}</div>
        <div class="badges">
          <span class="badge">${stars(v.rating)}</span>
          <span class="badge">📍 ${escapeHTML(v.placeName || "Place")}</span>
        </div>
      </div>
    `;
    card.addEventListener("click", () => openViewModal(v));
    list.appendChild(card);
  }
}

function renderTimeline() {
  const wrap = el("timelineList");
  wrap.innerHTML = "";

  for (const v of state.visits.slice(0, 40)) {
    const row = document.createElement("div");
    row.className = "titem";
    row.innerHTML = `
      <img class="tn" src="${escapeAttr(photoSrc(v))}" alt="thumb" loading="lazy" />
      <div class="tmeta">
        <div class="p">${escapeHTML(v.placeName || "Unknown place")}</div>
        <div class="d">${formatDateISO(v.dateISO)} • ${stars(v.rating)}</div>
      </div>
    `;
    row.addEventListener("click", () => openViewModal(v));
    wrap.appendChild(row);
  }
}

// ---------- Calendar ----------
function shiftMonth(delta) {
  const d = new Date(state.calendarMonth);
  d.setMonth(d.getMonth() + delta);
  state.calendarMonth = d;
  renderCalendar();
}
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Recompressió adaptativa per NO passar el límit de Firestore (~1MB/doc)
async function ensureFirestoreSafeImage(fileOrBlob) {
  // Prioritzem quedar molt per sota del límit: target ~650KB
  let blob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob]);

  // Si ja és petit, ok
  if (blob.size <= 650 * 1024) return blob;

  // Si tens compressImage importat (tu el tens via utils.js), el reutilitzem
  // Anem baixant maxSide i quality fins que quedi prou petit
  const steps = [
    { maxSide: 1400, quality: 0.72 },
    { maxSide: 1200, quality: 0.65 },
    { maxSide: 1000, quality: 0.60 },
    { maxSide: 900,  quality: 0.55 },
    { maxSide: 800,  quality: 0.50 },
    { maxSide: 700,  quality: 0.48 },
  ];

  // Necessitem el fitxer original per recomprimir bé:
  // fem servir state.selectedPhotoFile si existeix; si no, provem amb el blob.
  const source = state.selectedPhotoFile || blob;

  for (const s of steps) {
    const b = await compressImage(source, s);
    if (b.size <= 650 * 1024) return b;
    blob = b;
  }

  // Últim recurs: retorna el més petit aconseguit
  return blob;
}

function photoSrc(v) {
  return v.photoData || v.photoURL || "";
}

function renderCalendar() {
  const grid = el("calendarGrid");
  grid.innerHTML = "";

  const d = new Date(state.calendarMonth);
  const year = d.getFullYear();
  const month = d.getMonth();

  el("monthLabel").textContent = d.toLocaleDateString(undefined, { year:"numeric", month:"long" });

  const dayNames = ["Dl","Dt","Dc","Dj","Dv","Ds","Dg"];

  for (const name of dayNames) {
    const h = document.createElement("div");
    h.className = "day-head";
    h.textContent = name;
    grid.appendChild(h);
  }

  // Map visits by dateISO
  const byDate = new Map();
  for (const v of state.visits) {
    if (!v.dateISO) continue;
    if (!byDate.has(v.dateISO)) byDate.set(v.dateISO, []);
    byDate.get(v.dateISO).push(v);
  }

  // First day of month
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // convert Sunday=0 to Sunday=6, Monday=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Build 6 weeks view
  const totalCells = 6 * 7;
  const startDate = new Date(year, month, 1 - startDow);

  for (let i = 0; i < totalCells; i++) {
    const cur = new Date(startDate);
    cur.setDate(startDate.getDate() + i);

    const iso = toISO(cur);
    const isThisMonth = cur.getMonth() === month;
    const dayVisits = byDate.get(iso) || [];

    const cell = document.createElement("div");
    cell.className = "day" + (isThisMonth ? "" : " mutedDay") + (dayVisits.length ? " hasVisits" : "");
    cell.innerHTML = `
      <div class="n">${cur.getDate()}</div>
      <div class="thumbs">
        ${dayVisits.slice(0, 4).map(v => `<img class="tn" src="${escapeAttr(photoSrc(v))}" alt="tn" />`)}
        ${dayVisits.length > 4 ? `<span class="pill">+${dayVisits.length - 4}</span>` : ""}
      </div>
    `;
    cell.addEventListener("click", () => {
      if (!dayVisits.length) {
        toast("No visits that day (yet).");
        return;
      }
      // open newest for the day
      openViewModal(dayVisits[0]);
    });

    grid.appendChild(cell);
  }
}

// ---------- Stats ----------
function computeMonthStats() {
  const now = new Date();
  const mk = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const count = state.visits.filter(v => monthKeyFromISO(v.dateISO) === mk).length;
  el("monthVisits").textContent = String(count);
}

function computeTopPlace() {
  if (!state.places.length) { el("topPlace").textContent = "—"; return; }
  const top = [...state.places].sort((a,b) => (b.visitsCount||0)-(a.visitsCount||0))[0];
  el("topPlace").textContent = top ? top.name : "—";
}

function computeStreak() {
  // streak: consecutive days with at least one visit, ending at most recent visit date
  const dates = Array.from(new Set(state.visits.map(v => v.dateISO).filter(Boolean))).sort().reverse();
  if (!dates.length) { el("streak").textContent = "0 days"; return; }

  let streak = 1;
  for (let i = 0; i < dates.length - 1; i++) {
    const a = new Date(dates[i]);
    const b = new Date(dates[i+1]);
    const diffDays = Math.round((a - b) / (1000*60*60*24));
    if (diffDays === 1) streak++;
    else break;
  }
  el("streak").textContent = `${streak} day${streak === 1 ? "" : "s"}`;
}

// ---------- Map ----------
function initMap() {
  // Barcelona center
  const center = [41.3851, 2.1734];

  state.map = L.map("map", { zoomControl: false }).setView(center, 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(state.map);

  L.control.zoom({ position: "bottomright" }).addTo(state.map);
}

function refreshMapMarkers() {
  if (!state.map) return;

  // remove markers that no longer exist
  for (const [pid, marker] of state.markers.entries()) {
    if (!state.places.find(p => p.id === pid)) {
      marker.remove();
      state.markers.delete(pid);
    }
  }

  const visitedIds = new Set(state.visits.map(v => v.placeId).filter(Boolean));

  for (const p of state.places) {
    const hasCoords = isFiniteNumber(p.lat) && isFiniteNumber(p.lng);
    if (!hasCoords) continue;

    const visited = visitedIds.has(p.id);
const color = visited ? "#ff0000" : "#da0000";

    // create marker if missing
    if (!state.markers.has(p.id)) {
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 9,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.35,
      }).addTo(state.map);

      m.on("click", () => {
        state.selectedPlaceId = p.id;
        el("placeFilter").value = p.id;
        applyFilters();
        toast(`Filtered: ${p.name}`);
      });

      state.markers.set(p.id, m);
    } else {
      const m = state.markers.get(p.id);
      m.setStyle({ color, fillColor: color });
    }

    const mapsLink = p.mapsUrl ? `<a href="${escapeAttr(p.mapsUrl)}" target="_blank" rel="noreferrer">Open in Maps</a>` : "";
    state.markers.get(p.id).bindPopup(`
      <div style="font-weight:800;margin-bottom:6px;">${escapeHTML(p.name)}</div>
      <div style="opacity:0.75;font-size:12px;margin-bottom:8px;">Visits: ${Number(p.visitsCount||0)}</div>
      <button id="popup-${p.id}" style="cursor:pointer;border-radius:10px;border:1px solid rgba(0,0,0,0.18);padding:6px 10px;">Show visits</button>
      <div style="margin-top:8px;font-size:12px;">${mapsLink}</div>
    `);

    // attach popup button after open
    state.markers.get(p.id).on("popupopen", () => {
      const btn = document.getElementById(`popup-${p.id}`);
      if (btn) btn.onclick = () => {
        state.selectedPlaceId = p.id;
        el("placeFilter").value = p.id;
        switchTab("history");
        applyFilters();
      };
    });
  }
}

function fitMapToMarkers() {
  if (!state.map || state.markers.size === 0) {
    toast("No pinned places yet.");
    return;
  }
  const latlngs = Array.from(state.markers.values()).map(m => m.getLatLng());
  const bounds = L.latLngBounds(latlngs);
  state.map.fitBounds(bounds.pad(0.25));
}

// ---------- Modals ----------
function openModal() {
  el("modal").classList.add("show");
  el("modal").setAttribute("aria-hidden", "false");

  // reset form state (keep date default)
  el("visitRating").value = "";
  el("visitNotes").value = "";
  el("visitPlaceSelect").value = "";
  state.newPlaceMode = false;
  el("newPlaceBox").hidden = true;
  el("btnToggleNewPlace").textContent = "+ New";

  el("newPlaceName").value = "";
  el("newPlaceLink").value = "";
  el("newPlaceLat").value = "";
  el("newPlaceLng").value = "";

  clearPhoto();
}

function closeModal() {
  el("modal").classList.remove("show");
  el("modal").setAttribute("aria-hidden", "true");
}

function openViewModal(visit) {
  state.viewVisit = visit;

  el("viewTitle").textContent = visit.placeName || "Visit";
  el("viewImg").src = photoSrc(visit);
  el("viewDate").textContent = formatDateISO(visit.dateISO);
  el("viewPlace").textContent = safeText(visit.placeName);
  el("viewRating").textContent = stars(visit.rating);
  el("viewNotes").textContent = safeText(visit.notes, "No notes");
  el("viewMaps").innerHTML = "—";

  const place = state.places.find(p => p.id === visit.placeId);
  if (place?.mapsUrl) {
    el("viewMaps").innerHTML = `<a href="${escapeAttr(place.mapsUrl)}" target="_blank" rel="noreferrer">Open in Maps</a>`;
  }

  el("viewModal").classList.add("show");
  el("viewModal").setAttribute("aria-hidden", "false");
}

function closeViewModal() {
  el("viewModal").classList.remove("show");
  el("viewModal").setAttribute("aria-hidden", "true");
  state.viewVisit = null;
}

// ---------- Photo picking ----------
async function onPhotoPicked(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;

  state.selectedPhotoFile = file;

  // Show preview immediately (original)
  if (state.selectedPhotoPreviewURL) URL.revokeObjectURL(state.selectedPhotoPreviewURL);
  state.selectedPhotoPreviewURL = URL.createObjectURL(file);
  el("photoPreview").innerHTML = `<img src="${state.selectedPhotoPreviewURL}" alt="Selected photo" />`;

  el("btnRemovePhoto").disabled = false;

  // Compress in background
  try {
    const blob = await compressImage(file, { maxSide: 1600, quality: 0.82 });
    state.selectedPhotoBlob = blob;

    const kb = Math.round(blob.size / 1024);
    toast(`Photo ready (${kb} KB)`);
  } catch (e) {
    console.error(e);
    state.selectedPhotoBlob = null;
    toast("Photo compression failed. Try another photo.");
  }
}

function clearPhoto() {
  el("photoInput").value = "";
  state.selectedPhotoFile = null;
  state.selectedPhotoBlob = null;
  if (state.selectedPhotoPreviewURL) URL.revokeObjectURL(state.selectedPhotoPreviewURL);
  state.selectedPhotoPreviewURL = null;

  el("photoPreview").innerHTML = `
    <div class="photo-placeholder">
      <div class="photo-emoji">📸</div>
      <div class="muted">Add a photo to unlock the counter.</div>
    </div>`;
  el("btnRemovePhoto").disabled = true;
}

// ---------- Submit visit ----------
async function onSubmitVisit(ev) {
  ev.preventDefault();

  const dateISO = el("visitDate").value;
  const rating = el("visitRating").value ? Number(el("visitRating").value) : null;
  const notes = el("visitNotes").value.trim();

  // Photo required
  if (!state.selectedPhotoBlob) {
    toast("Photo required ✋");
    return;
  }

  // Determine place
  let placeId = el("visitPlaceSelect").value;
  let placeName = "";

  if (state.newPlaceMode) {
    const name = el("newPlaceName").value.trim();
    if (!name) {
      toast("Enter a place name.");
      return;
    }
    const mapsUrl = el("newPlaceLink").value.trim() || null;
    const lat = parseFloat(el("newPlaceLat").value);
    const lng = parseFloat(el("newPlaceLng").value);

    // Create place doc
    const placeDoc = await fs.addDoc(fs.collection(db, "places"), {
      name,
      mapsUrl,
      lat: isFiniteNumber(lat) ? lat : null,
      lng: isFiniteNumber(lng) ? lng : null,
      visitsCount: 0,
      lastVisitedISO: null,
      createdAt: fs.serverTimestamp(),
    });
    placeId = placeDoc.id;
    placeName = name;
  } else {
    if (!placeId) {
      toast("Pick a place or create a new one.");
      return;
    }
    const p = state.places.find(x => x.id === placeId);
    placeName = p?.name || "Unknown place";
  }

  // Upload UI
  setUploadUI(true, 0, "Starting…");

  try {
    // 1) Create visit doc first (so we get visitId)
    const visitRef = await fs.addDoc(fs.collection(db, "visits"), {
      dateISO,
      placeId,
      placeName,
      notes: notes || null,
      rating,
      photoPath: null,
      photoURL: null,
      createdAt: fs.serverTimestamp(),
    });

    const visitId = visitRef.id;

    // 2) Upload photo to Storage
// 2) Guardar foto a Firestore (FREE): data URL Base64
setUploadUI(true, 10, "Optimitzant foto…");

const safeBlob = await ensureFirestoreSafeImage(state.selectedPhotoBlob);
const kb = Math.round(safeBlob.size / 1024);
setUploadUI(true, 35, `Preparant… (${kb} KB)`);

const photoData = await blobToDataURL(safeBlob);
setUploadUI(true, 60, "Guardant a Firestore…");

// 3) Update visit doc with photoData
await fs.updateDoc(fs.doc(db, "visits", visitId), {
  photoData,      // <- nou
  photoPath: null,
  photoURL: null,
});

    // 4) Increment stats + place counter
    await fs.setDoc(fs.doc(db, "stats", "global"), {
      totalVisits: fs.increment(1),
      updatedAt: fs.serverTimestamp(),
    }, { merge: true });

    await fs.updateDoc(fs.doc(db, "places", placeId), {
      visitsCount: fs.increment(1),
      lastVisitedISO: dateISO,
    });

    setUploadUI(false, 100, "Done");
    toast("Visit saved ✅");
    closeModal();
  } catch (e) {
    console.error(e);
    toast("Save failed — check Firebase rules & console.");
    setUploadUI(false, 0, "");
  }
}

function setUploadUI(show, pct, text) {
  el("uploadMeter").hidden = !show;
  el("uploadBar").style.width = `${pct}%`;
  el("uploadText").textContent = text || "Uploading…";
}

// ---------- Helpers ----------
function isoToday() {
  const d = new Date();
  return toISO(d);
}

function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(s) {
  // for putting into src/href
  return escapeHTML(s).replaceAll("`", "&#096;");
}
