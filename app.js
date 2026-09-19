const SUPABASE_URL = "https://ypgddxhgrzghbrghyrzf.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_RF9DMVXE3ArfI25wpVI7bg_3H8DeLXg";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

let session = null;
let records = [];
let editingId = null;
let map = null;
let markerLayer = null;

const el = (id) => document.getElementById(id);
const fields = [
  "customer_name", "address_line1", "city", "state", "postal_code",
  "install_date", "manufacturer", "model_number", "door_size",
  "spring_size", "door_type", "color", "lift_type", "spring_count", "notes"
];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  const result = await sb.auth.getSession();
  session = result.data.session;
  await syncAuthView();

  sb.auth.onAuthStateChange(async (_event, newSession) => {
    session = newSession;
    await syncAuthView();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bindEvents() {
  el("authForm").addEventListener("submit", signIn);
  el("signUpBtn").addEventListener("click", signUp);
  el("signOutBtn").addEventListener("click", () => sb.auth.signOut());
  el("addBtn").addEventListener("click", () => openRecordDialog());
  el("searchInput").addEventListener("input", renderRecords);
  el("mapToggleBtn").addEventListener("click", toggleMap);
  el("exportBtn").addEventListener("click", exportCsv);
  el("recordForm").addEventListener("submit", saveRecord);
  el("closeDialogBtn").addEventListener("click", closeRecordDialog);
  el("cancelBtn").addEventListener("click", closeRecordDialog);
  el("recordDialog").addEventListener("click", (event) => {
    if (event.target === el("recordDialog")) closeRecordDialog();
  });
}

async function syncAuthView() {
  const signedIn = !!session;
  el("authView").classList.toggle("hidden", signedIn);
  el("appView").classList.toggle("hidden", !signedIn);
  el("userArea").classList.toggle("hidden", !signedIn);

  if (signedIn) {
    el("userEmail").textContent = session.user.email || "";
    await loadRecords();
  } else {
    records = [];
    el("recordsList").innerHTML = "";
  }
}

async function signIn(event) {
  event.preventDefault();
  setAuthMessage("Signing in...");
  const { error } = await sb.auth.signInWithPassword({
    email: el("email").value.trim(),
    password: el("password").value
  });
  if (error) setAuthMessage(error.message, true);
  else setAuthMessage("");
}

async function signUp() {
  const email = el("email").value.trim();
  const password = el("password").value;
  if (!email || password.length < 6) {
    setAuthMessage("Enter an email and a password of at least 6 characters.", true);
    return;
  }
  setAuthMessage("Creating account...");
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) {
    setAuthMessage(error.message, true);
    return;
  }
  if (data.session) setAuthMessage("Account created.");
  else setAuthMessage("Account created. Check your email for the confirmation link, then sign in.");
}

function setAuthMessage(message, isError) {
  el("authMessage").textContent = message || "";
  el("authMessage").style.color = isError ? "#fecdd3" : "";
}

async function loadRecords() {
  const { data, error } = await sb
    .from("installations")
    .select("*")
    .order("install_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    showToast("Database not ready: " + error.message, true);
    return;
  }

  records = data || [];
  renderRecords();
  renderMapMarkers();
}

function renderRecords() {
  const query = el("searchInput").value.trim().toLowerCase();
  const filtered = records.filter((record) => {
    if (!query) return true;
    return [
      record.customer_name, record.address_line1, record.city, record.state,
      record.postal_code, record.manufacturer, record.model_number,
      record.door_size, record.spring_size, record.door_type,
      record.color, record.lift_type, record.notes
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });

  el("recordCount").textContent = records.length;
  el("filterCount").textContent = query ? filtered.length + " matching" : "";
  el("emptyState").classList.toggle("hidden", records.length !== 0);

  if (!filtered.length) {
    el("recordsList").innerHTML = records.length
      ? '<div class="empty-state"><h3>No matches</h3><p>Try a different search.</p></div>'
      : "";
    return;
  }

  el("recordsList").innerHTML = filtered.map(recordCardHtml).join("");
  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => openRecordDialog(button.dataset.edit));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteRecord(button.dataset.delete));
  });
  document.querySelectorAll("[data-map]").forEach((button) => {
    button.addEventListener("click", () => focusRecordOnMap(button.dataset.map));
  });
}

function recordCardHtml(record) {
  const address = fullAddress(record);
  const details = [
    ["Model", joinParts(record.manufacturer, record.model_number)],
    ["Door size", record.door_size],
    ["Spring", record.spring_size],
    ["Type", record.door_type],
    ["Color", record.color],
    ["Lift", record.lift_type]
  ].filter((item) => item[1]);

  return '<article class="record-card">' +
    '<div class="record-top"><div>' +
      (record.customer_name ? '<div class="eyebrow">' + esc(record.customer_name) + '</div>' : '') +
      '<div class="record-address">' + esc(address || "No address") + '</div>' +
    '</div><div class="record-date">' + esc(formatDate(record.install_date)) + '</div></div>' +
    '<div class="record-details">' +
      details.map((item) => '<div class="detail"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong></div>').join("") +
    '</div>' +
    (record.notes ? '<p class="muted">' + esc(record.notes) + '</p>' : '') +
    '<div class="record-actions">' +
      '<button class="button secondary small" data-edit="' + esc(record.id) + '">Edit</button>' +
      '<button class="button secondary small" data-map="' + esc(record.id) + '">Map</button>' +
      '<button class="button danger small" data-delete="' + esc(record.id) + '">Delete</button>' +
    '</div>' +
  '</article>';
}

function openRecordDialog(id) {
  editingId = id || null;
  el("recordForm").reset();

  if (editingId) {
    const record = records.find((item) => item.id === editingId);
    if (!record) return;
    el("dialogTitle").textContent = "Edit installation";
    fields.forEach((name) => {
      el(name).value = record[name] ?? "";
    });
  } else {
    el("dialogTitle").textContent = "Add installation";
    el("install_date").value = new Date().toISOString().slice(0, 10);
  }

  el("recordDialog").showModal();
}

function closeRecordDialog() {
  editingId = null;
  el("recordDialog").close();
}

async function saveRecord(event) {
  event.preventDefault();
  if (!session) return;

  const wasEditing = !!editingId;
  const recordId = editingId;
  const existing = recordId ? records.find((item) => item.id === recordId) : null;
  const payload = { user_id: session.user.id };

  fields.forEach((name) => {
    let value = el(name).value.trim();
    if (name === "spring_count") value = value === "" ? null : Number(value);
    payload[name] = value === "" ? null : value;
  });

  if (!payload.address_line1 || !payload.city || !payload.state || !payload.install_date) {
    showToast("Address, city, state and install date are required.", true);
    return;
  }

  el("saveBtn").disabled = true;
  el("saveBtn").textContent = "Saving...";

  const addressChanged = !existing ||
    fullAddress(existing).toLowerCase() !== fullAddress(payload).toLowerCase();

  if (addressChanged || existing?.latitude == null || existing?.longitude == null) {
    const coords = await geocodeAddress(fullAddress(payload));
    payload.latitude = coords ? coords.lat : null;
    payload.longitude = coords ? coords.lng : null;
  } else {
    payload.latitude = existing.latitude;
    payload.longitude = existing.longitude;
  }

  const result = wasEditing
    ? await sb.from("installations").update(payload).eq("id", recordId)
    : await sb.from("installations").insert(payload);

  el("saveBtn").disabled = false;
  el("saveBtn").textContent = "Save installation";

  if (result.error) {
    showToast(result.error.message, true);
    return;
  }

  closeRecordDialog();
  showToast(wasEditing ? "Installation updated." : "Installation saved.");
  await loadRecords();
}

async function deleteRecord(id) {
  const record = records.find((item) => item.id === id);
  if (!record) return;

  const ok = window.confirm("Delete this installation?\n\n" + fullAddress(record));
  if (!ok) return;

  const { error } = await sb.from("installations").delete().eq("id", id);
  if (error) {
    showToast(error.message, true);
    return;
  }

  showToast("Installation deleted.");
  await loadRecords();
}

async function geocodeAddress(address) {
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=" + encodeURIComponent(address);
    const response = await fetch(url, { headers: { "Accept-Language": "en" } });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.length) return null;
    return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
  } catch {
    return null;
  }
}

function toggleMap() {
  const panel = el("mapPanel");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");
  el("mapToggleBtn").textContent = opening ? "Hide map" : "Show map";

  if (opening) {
    ensureMap();
    setTimeout(() => {
      map.invalidateSize();
      fitMap();
    }, 120);
  }
}

function ensureMap() {
  if (map) return;

  map = L.map("map").setView([37.8, -96], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
  renderMapMarkers();
}

function renderMapMarkers() {
  if (!map || !markerLayer) return;

  markerLayer.clearLayers();
  records
    .filter((record) => record.latitude != null && record.longitude != null)
    .forEach((record) => {
      const marker = L.marker([record.latitude, record.longitude]).addTo(markerLayer);
      marker.bindPopup(
        "<strong>" + esc(fullAddress(record)) + "</strong><br>" +
        esc(joinParts(record.manufacturer, record.model_number) || "Garage door") +
        (record.door_size ? "<br>" + esc(record.door_size) : "")
      );
      marker.options.recordId = record.id;
    });

  fitMap();
}

function fitMap() {
  if (!map || !markerLayer) return;

  const layers = markerLayer.getLayers();
  if (!layers.length) return;

  if (layers.length === 1) {
    map.setView(layers[0].getLatLng(), 15);
  } else {
    map.fitBounds(L.featureGroup(layers).getBounds().pad(0.15));
  }
}

function focusRecordOnMap(id) {
  const record = records.find((item) => item.id === id);
  if (!record) return;

  if (record.latitude == null || record.longitude == null) {
    window.open(
      "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(fullAddress(record)),
      "_blank",
      "noopener"
    );
    return;
  }

  if (el("mapPanel").classList.contains("hidden")) toggleMap();
  ensureMap();

  setTimeout(() => {
    map.setView([record.latitude, record.longitude], 16);
    const marker = markerLayer.getLayers().find((layer) => layer.options.recordId === id);
    if (marker) marker.openPopup();
  }, 150);
}

function exportCsv() {
  if (!records.length) {
    showToast("Nothing to export.", true);
    return;
  }

  const columns = [
    "customer_name","address_line1","city","state","postal_code","manufacturer",
    "model_number","door_size","spring_size","spring_count","door_type","color",
    "lift_type","install_date","notes"
  ];

  const rows = [columns].concat(
    records.map((record) => columns.map((column) => record[column] ?? ""))
  );

  const csv = rows.map((row) => row.map(csvValue).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "garage-door-installations-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}

function csvValue(value) {
  const text = String(value ?? "");
  return '"' + text.replaceAll('"', '""') + '"';
}

function fullAddress(record) {
  return [record.address_line1, record.city, record.state, record.postal_code]
    .filter(Boolean)
    .join(", ");
}

function joinParts(a, b) {
  return [a, b].filter(Boolean).join(" ");
}

function formatDate(value) {
  if (!value) return "";
  const parts = value.split("-");
  if (parts.length !== 3) return value;
  return Number(parts[1]) + "/" + Number(parts[2]) + "/" + parts[0];
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let toastTimer;
function showToast(message, isError) {
  clearTimeout(toastTimer);
  el("toast").textContent = message;
  el("toast").classList.toggle("error", !!isError);
  el("toast").classList.remove("hidden");
  toastTimer = setTimeout(() => el("toast").classList.add("hidden"), 4200);
}
