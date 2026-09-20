const SUPABASE_URL = "https://ypgddxhgrzghbrghyrzf.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_RF9DMVXE3ArfI25wpVI7bg_3H8DeLXg";
const authLock = async (_name, _acquireTimeout, fn) => await fn();
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    lock: authLock
  }
});

let session = null;
let records = [];
let editingId = null;
let map = null;
let markerLayer = null;
let supportsExtraDoors = true;
const geocodeAttempted = new Set();
const extraDoorFields = [
  "manufacturer", "model_number", "door_size", "spring_size",
  "door_type", "color", "lift_type", "spring_count"
];

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

  sb.auth.onAuthStateChange((_event, newSession) => {
    session = newSession;
    // Do not await Supabase/database work inside the auth callback.
    // Supabase documents that async API calls here can deadlock auth.
    setTimeout(() => {
      syncAuthView().catch((error) => {
        console.error("Auth view sync failed:", error);
        showToast("Signed in, but loading records failed. Refresh and try again.", true);
      });
    }, 0);
  });

}

function bindEvents() {
  el("authForm").addEventListener("submit", signIn);
  el("signOutBtn").addEventListener("click", () => sb.auth.signOut());
  el("addBtn").addEventListener("click", () => openRecordDialog());
  el("addExtraDoorBtn").addEventListener("click", () => addExtraDoorCard());
  el("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    renderRecords();
    renderMapMarkers();
  });
  el("searchInput").addEventListener("input", () => {
    renderRecords();
    renderMapMarkers();
  });
  el("clearSearchBtn").addEventListener("click", () => {
    el("searchInput").value = "";
    renderRecords();
    renderMapMarkers();
    el("searchInput").focus();
  });
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

  const email = el("email").value.trim();
  const password = el("password").value;

  if (!email || !password) {
    setAuthMessage("Enter your email and password.", true);
    return;
  }

  const button = el("signInBtn");
  button.disabled = true;
  button.textContent = "Signing in...";
  setAuthMessage("");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    // Use the Auth REST endpoint directly so a stale browser auth lock
    // cannot leave the sign-in button hanging indefinitely.
    const response = await fetch(
      SUPABASE_URL + "/auth/v1/token?grant_type=password",
      {
        method: "POST",
        headers: {
          "apikey": SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, password }),
        signal: controller.signal
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data.msg || data.message || data.error_description || data.error || ("HTTP " + response.status);
      setAuthMessage("Sign-in failed: " + message, true);
      return;
    }

    if (!data.access_token || !data.refresh_token) {
      setAuthMessage("Sign-in failed: the login service returned an incomplete session.", true);
      return;
    }

    const sessionResult = await Promise.race([
      sb.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SESSION_TIMEOUT")), 10000)
      )
    ]);

    if (sessionResult.error) {
      setAuthMessage("Sign-in failed: " + sessionResult.error.message, true);
      return;
    }

    session = sessionResult.data.session;
    setAuthMessage("");
    await syncAuthView();
  } catch (error) {
    console.error("Sign-in request failed:", error);
    if (error?.name === "AbortError") {
      setAuthMessage("The login service did not respond within 30 seconds. Please try again.", true);
    } else if (error?.message === "SESSION_TIMEOUT") {
      setAuthMessage("Login succeeded, but the browser session could not be saved. Close other tracker tabs and try again.", true);
    } else {
      setAuthMessage("Could not reach the login service. Check your connection and try again.", true);
    }
  } finally {
    clearTimeout(timeoutId);
    button.disabled = false;
    button.textContent = "Sign in";
  }
}

function setAuthMessage(message, isError) {
  el("authMessage").textContent = message || "";
  el("authMessage").style.color = isError ? "#fecdd3" : "";
}

async function loadRecords() {
  const supportCheck = await sb.from("installations").select("extra_doors").limit(1);
  supportsExtraDoors = !supportCheck.error;
  el("addExtraDoorBtn").disabled = !supportsExtraDoors;
  el("addExtraDoorBtn").title = supportsExtraDoors
    ? "Add another door to this installation"
    : "Database update required before adding extra doors";

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
  ensureMap();
  renderMapMarkers();
  refreshMapCoordinates();
}

function getFilteredRecords() {
  const query = el("searchInput").value.trim().toLowerCase();
  if (!query) return records;

  const terms = query.split(/\s+/).filter(Boolean);

  return records.filter((record) => {
    const haystack = [
      record.customer_name,
      record.address_line1,
      record.city,
      record.state,
      record.postal_code,
      record.manufacturer,
      record.model_number,
      record.door_size,
      record.spring_size,
      record.spring_count,
      record.door_type,
      record.color,
      record.lift_type,
      record.install_date,
      formatDate(record.install_date),
      record.notes,
      JSON.stringify(record.extra_doors || [])
    ].map((value) => String(value || "").toLowerCase()).join(" ");

    return terms.every((term) => haystack.includes(term));
  });
}

function renderRecords() {
  const query = el("searchInput").value.trim();
  const filtered = getFilteredRecords();

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
  const extraDoors = Array.isArray(record.extra_doors) ? record.extra_doors : [];
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
    (extraDoors.length
      ? '<div class="extra-door-summary-list">' +
        extraDoors.map((door, index) =>
          '<div class="extra-door-summary"><strong>Door ' + (index + 2) + '</strong><span>' +
          esc(extraDoorSummary(door)) + '</span></div>'
        ).join("") +
        '</div>'
      : '') +
    (record.notes ? '<p class="muted">' + esc(record.notes) + '</p>' : '') +
    '<div class="record-actions">' +
      '<button class="button secondary small" data-edit="' + esc(record.id) + '">Edit</button>' +
      '<button class="button secondary small" data-map="' + esc(record.id) + '">Map</button>' +
      '<button class="button danger small" data-delete="' + esc(record.id) + '">Delete</button>' +
    '</div>' +
  '</article>';
}

function extraDoorSummary(door) {
  const parts = [
    joinParts(door.manufacturer, door.model_number),
    door.door_size,
    door.spring_size ? "Spring " + door.spring_size : "",
    door.door_type,
    door.color,
    door.lift_type
  ].filter(Boolean);
  return parts.join(" • ") || "Additional door";
}

function addExtraDoorCard(door = {}) {
  if (!supportsExtraDoors) {
    showToast("Run the multi-door database update first, then refresh the app.", true);
    return;
  }

  const container = el("extraDoorsContainer");
  const card = document.createElement("div");
  card.className = "extra-door-card";
  card.innerHTML =
    '<div class="extra-door-card-header">' +
      '<strong>Additional door</strong>' +
      '<button class="button danger small remove-extra-door" type="button">Remove</button>' +
    '</div>' +
    '<div class="extra-door-grid">' +
      '<label>Manufacturer<input data-door-field="manufacturer" placeholder="Clopay, Wayne Dalton..."></label>' +
      '<label>Model #<input data-door-field="model_number"></label>' +
      '<label>Door size<input data-door-field="door_size" placeholder="16 x 7"></label>' +
      '<label>Spring size<input data-door-field="spring_size" placeholder=".250 x 2 x 31"></label>' +
      '<label>Door type<input data-door-field="door_type" list="doorTypes" placeholder="Raised panel"></label>' +
      '<label>Color<input data-door-field="color" list="colors" placeholder="White"></label>' +
      '<label>Lift<input data-door-field="lift_type" list="liftTypes" placeholder="Standard lift"></label>' +
      '<label>Number of springs<input data-door-field="spring_count" type="number" min="0" step="1"></label>' +
    '</div>';

  extraDoorFields.forEach((name) => {
    const input = card.querySelector('[data-door-field="' + name + '"]');
    if (!input) return;
    const value = door[name];
    input.value = value == null ? "" : value;
  });

  card.querySelector(".remove-extra-door").addEventListener("click", () => {
    card.remove();
    renumberExtraDoors();
  });

  container.appendChild(card);
  renumberExtraDoors();
}

function renumberExtraDoors() {
  el("extraDoorsContainer").querySelectorAll(".extra-door-card").forEach((card, index) => {
    const title = card.querySelector(".extra-door-card-header strong");
    if (title) title.textContent = "Door " + (index + 2);
  });
}

function renderExtraDoors(doors) {
  const container = el("extraDoorsContainer");
  container.innerHTML = "";
  if (!supportsExtraDoors || !Array.isArray(doors)) return;
  doors.forEach((door) => addExtraDoorCard(door));
}

function collectExtraDoors() {
  return Array.from(el("extraDoorsContainer").querySelectorAll(".extra-door-card"))
    .map((card) => {
      const door = {};
      extraDoorFields.forEach((name) => {
        const input = card.querySelector('[data-door-field="' + name + '"]');
        if (!input) return;
        let value = input.value.trim();
        if (name === "spring_count") value = value === "" ? null : Number(value);
        door[name] = value === "" ? null : value;
      });
      return door;
    })
    .filter((door) => extraDoorFields.some((name) => door[name] !== null && door[name] !== ""));
}

function openRecordDialog(id) {
  editingId = id || null;
  el("recordForm").reset();
  el("extraDoorsContainer").innerHTML = "";

  if (editingId) {
    const record = records.find((item) => item.id === editingId);
    if (!record) return;
    el("dialogTitle").textContent = "Edit installation";
    fields.forEach((name) => {
      el(name).value = record[name] ?? "";
    });
    renderExtraDoors(record.extra_doors || []);
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

  if (supportsExtraDoors) {
    payload.extra_doors = collectExtraDoors();
  }

  if (!payload.address_line1 || !payload.city || !payload.state || !payload.install_date) {
    showToast("Address, city, state and install date are required.", true);
    return;
  }

  el("saveBtn").disabled = true;
  el("saveBtn").textContent = "Saving...";

  const addressChanged = !existing ||
    fullAddress(existing).toLowerCase() !== fullAddress(payload).toLowerCase();

  if (addressChanged || existing?.latitude == null || existing?.longitude == null) {
    const coords = await geocodeRecord(payload);
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

function normalizeGeoText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(street)\b/g, "st")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(boulevard)\b/g, "blvd")
    .replace(/\b(drive)\b/g, "dr")
    .replace(/\b(lane)\b/g, "ln")
    .replace(/\b(highway)\b/g, "hwy")
    .replace(/\b(route)\b/g, "rte")
    .replace(/\b(north)\b/g, "n")
    .replace(/\b(south)\b/g, "s")
    .replace(/\b(east)\b/g, "e")
    .replace(/\b(west)\b/g, "w")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseStreet(value) {
  const cleaned = String(value || "")
    .replace(/\s+(apt|apartment|unit|suite|ste|#)\s*.*$/i, "")
    .trim();
  const match = cleaned.match(/^(\d+[a-zA-Z0-9-]*)\s+(.+)$/);
  return {
    full: cleaned,
    house: match ? match[1] : "",
    road: match ? match[2] : cleaned
  };
}

function resultRoad(address = {}) {
  return address.road || address.residential || address.pedestrian ||
    address.highway || address.path || address.place || "";
}

function resultLocality(address = {}) {
  return address.city || address.town || address.village ||
    address.hamlet || address.municipality || address.county || "";
}

function roadCore(value) {
  const stop = new Set(["st","rd","ave","blvd","dr","ln","hwy","rte","ct","cir","pl","pkwy","way","ter"]);
  return normalizeGeoText(value)
    .split(" ")
    .filter((token) => token && !stop.has(token))
    .join(" ");
}

function isConfidentStreetMatch(result, record) {
  const address = result.address || {};
  const inputStreet = parseStreet(record.address_line1);
  const inputRoad = roadCore(inputStreet.road);
  const matchedRoad = roadCore(resultRoad(address));
  const resultHouse = normalizeGeoText(address.house_number || "");

  if (inputStreet.house && resultHouse !== normalizeGeoText(inputStreet.house)) {
    return false;
  }

  if (inputRoad && matchedRoad) {
    const roadMatches = matchedRoad.includes(inputRoad) || inputRoad.includes(matchedRoad);
    if (!roadMatches) return false;
  } else if (inputRoad) {
    const display = normalizeGeoText(result.display_name || "");
    if (!display.includes(inputRoad)) return false;
  }

  const city = normalizeGeoText(normalizeCity(record.city, record.state));
  const locality = normalizeGeoText(resultLocality(address));
  const display = normalizeGeoText(result.display_name || "");
  if (city && locality && city !== locality && !display.includes(city)) {
    return false;
  }

  const inputZip = String(record.postal_code || "").trim().slice(0, 5);
  const resultZip = String(address.postcode || "").trim().slice(0, 5);
  if (inputZip && resultZip && inputZip !== resultZip) {
    return false;
  }

  return Number.isFinite(Number(result.lat)) && Number.isFinite(Number(result.lon));
}

async function nominatimSearch(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Language": "en"
      }
    });
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.warn("Geocoding request failed:", error);
    return [];
  }
}

async function geocodeRecord(record) {
  const street = parseStreet(record.address_line1).full;
  const city = normalizeCity(record.city, record.state);
  const state = String(record.state || "").trim();
  const zip = String(record.postal_code || "").trim();

  // First use Nominatim's structured address search.
  const structured = new URLSearchParams({
    format: "jsonv2",
    limit: "5",
    addressdetails: "1",
    countrycodes: "us",
    street
  });
  if (city) structured.set("city", city);
  if (state) structured.set("state", state);
  if (zip) structured.set("postalcode", zip);

  let results = await nominatimSearch(
    "https://nominatim.openstreetmap.org/search?" + structured.toString()
  );

  // If structured search misses, try only the complete street address.
  if (!results.some((result) => isConfidentStreetMatch(result, record))) {
    const full = [street, city, state, zip].filter(Boolean).join(", ");
    const freeform = new URLSearchParams({
      format: "jsonv2",
      limit: "5",
      addressdetails: "1",
      countrycodes: "us",
      q: full
    });
    results = await nominatimSearch(
      "https://nominatim.openstreetmap.org/search?" + freeform.toString()
    );
  }

  const match = results.find((result) => isConfidentStreetMatch(result, record));
  if (!match) return null;

  return { lat: Number(match.lat), lng: Number(match.lon) };
}

async function refreshMapCoordinates() {
  if (!session) return;

  const candidates = records.filter((record) => !geocodeAttempted.has(record.id));
  if (!candidates.length) return;

  for (const record of candidates) {
    geocodeAttempted.add(record.id);
    const coords = await geocodeRecord(record);

    // Never keep an approximate city/ZIP pin when the street address cannot be verified.
    if (!coords) {
      if (record.latitude != null || record.longitude != null) {
        const { error } = await sb
          .from("installations")
          .update({ latitude: null, longitude: null })
          .eq("id", record.id);

        if (!error) {
          record.latitude = null;
          record.longitude = null;
          renderMapMarkers();
        }
      }
    } else {
      const moved =
        record.latitude == null ||
        record.longitude == null ||
        Math.abs(Number(record.latitude) - coords.lat) > 0.00001 ||
        Math.abs(Number(record.longitude) - coords.lng) > 0.00001;

      if (moved) {
        const { error } = await sb
          .from("installations")
          .update({ latitude: coords.lat, longitude: coords.lng })
          .eq("id", record.id);

        if (!error) {
          record.latitude = coords.lat;
          record.longitude = coords.lng;
          renderMapMarkers();
        }
      }
    }

    // Keep requests under the public Nominatim rate limit.
    await new Promise((resolve) => setTimeout(resolve, 1100));
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
  getFilteredRecords()
    .filter((record) => record.latitude != null && record.longitude != null)
    .forEach((record) => {
      const pinIcon = L.divIcon({
        className: "installation-pin-icon",
        html: '<div class="installation-pin-dot"><span></span></div>',
        iconSize: [34, 42],
        iconAnchor: [17, 42],
        tooltipAnchor: [0, -36]
      });

      const marker = L.marker([record.latitude, record.longitude], {
        icon: pinIcon,
        title: fullAddress(record)
      }).addTo(markerLayer);

      marker.bindTooltip(
        "<strong>" + esc(fullAddress(record)) + "</strong><br>" +
        esc(joinParts(record.manufacturer, record.model_number) || "Garage door") +
        (record.door_size ? "<br>" + esc(record.door_size) : "") +
        "<br><em>Click to open record</em>",
        { direction: "top", offset: [0, -8] }
      );

      marker.on("click", () => openRecordDialog(record.id));
      marker.options.recordId = record.id;
    });

  fitMap();
}

function fitMap() {
  if (!map || !markerLayer) return;

  const layers = markerLayer.getLayers();
  if (!layers.length) return;

  if (layers.length === 1) {
    map.setView(layers[0].getLatLng(), 14);
  } else {
    map.fitBounds(L.featureGroup(layers).getBounds().pad(0.15));
  }
}

async function focusRecordOnMap(id) {
  const record = records.find((item) => item.id === id);
  if (!record) return;

  if (record.latitude == null || record.longitude == null) {
    showToast("Locating this installation...");
    const coords = await geocodeRecord(record);

    if (coords) {
      const { error } = await sb
        .from("installations")
        .update({ latitude: coords.lat, longitude: coords.lng })
        .eq("id", record.id);

      if (!error) {
        record.latitude = coords.lat;
        record.longitude = coords.lng;
        renderMapMarkers();
      }
    }
  }

  if (record.latitude == null || record.longitude == null) {
    showToast("No exact street-level map match was found. Opening the address in Google Maps instead.", true);
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
    map.invalidateSize();
    map.setView([record.latitude, record.longitude], 16);
    const marker = markerLayer.getLayers().find((layer) => layer.options.recordId === id);
    if (marker) marker.openTooltip();
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
    "lift_type","install_date","extra_doors","notes"
  ];

  const rows = [columns].concat(
    records.map((record) => columns.map((column) => {
      if (column === "extra_doors") return JSON.stringify(record.extra_doors || []);
      return record[column] ?? "";
    }))
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

function normalizeCity(city, state) {
  let value = String(city || "").trim();
  const stateValue = String(state || "").trim();

  if (!value || !stateValue) return value;

  const lowerValue = value.toLowerCase();
  const lowerState = stateValue.toLowerCase();

  if (lowerValue.endsWith(", " + lowerState)) {
    value = value.slice(0, -(stateValue.length + 2)).trim();
  } else if (lowerValue.endsWith(" " + lowerState)) {
    value = value.slice(0, -(stateValue.length + 1)).trim();
  }

  return value.replace(/,\s*$/, "").trim();
}

function fullAddress(record) {
  const city = normalizeCity(record.city, record.state);
  return [record.address_line1, city, record.state, record.postal_code]
    .map((value) => String(value || "").trim())
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
