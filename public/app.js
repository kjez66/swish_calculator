import { basketTotalOre, formatOre, parseKronorToOre } from "/shared/money.js";

const $ = (id) => document.getElementById(id);
const LS = "swish-kassa-room";

let room = JSON.parse(localStorage.getItem(LS) ?? "null");
let settings = null;
let products = [];
/** @type {Map<string, number>} product id -> quantity */
const basket = new Map();
let inFlight = false;

// --- API -------------------------------------------------------------------

async function api(method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}roomId=${room.roomId}`, {
    method,
    headers: {
      Authorization: `Bearer ${room.operatorToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? "fel"), { data, status: res.status });
  return data;
}

const ERRORS = {
  not_configured: "Ange butiksnamn och Swish-nummer i inställningar.",
  empty_basket: "Korgen är tom.",
  unknown_product: "En produkt i korgen finns inte längre. Uppdaterar listan.",
  bad_quantity: "Ogiltigt antal.",
  amount_too_low: "Beloppet är under 1 kr.",
  amount_too_high: "Beloppet är orimligt högt. Kontrollera korgen.",
  stale_total: "Priserna har ändrats. Kontrollera summan och tryck Betala igen.",
  charge_in_progress: "En betalning behandlas redan. Försök igen.",
  rate_limited: "För många försök. Vänta en minut.",
};

// --- rendering -------------------------------------------------------------

function renderProducts() {
  $("grid").innerHTML = "";
  for (const p of [...products].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const qty = basket.get(p.id) ?? 0;
    const btn = document.createElement("button");
    btn.className = "product";
    btn.innerHTML =
      `<span>${escapeHtml(p.name)}</span><span class="price">${formatOre(p.priceOre)}</span>` +
      (qty ? `<span class="qty">${qty}</span>` : "");
    btn.onclick = () => {
      basket.set(p.id, qty + 1);
      renderAll();
    };
    $("grid").append(btn);
  }
}

function renderBasket() {
  $("lines").innerHTML = "";
  for (const [id, qty] of basket) {
    const p = products.find((x) => x.id === id);
    if (!p) continue;
    const row = document.createElement("div");
    row.className = "line";
    row.innerHTML =
      `<span class="name">${qty} × ${escapeHtml(p.name)}</span>` +
      `<span>${formatOre(p.priceOre * qty)}</span>`;
    const minus = document.createElement("button");
    minus.textContent = "−";
    minus.onclick = () => {
      const next = qty - 1;
      if (next > 0) basket.set(id, next);
      else basket.delete(id);
      renderAll();
    };
    row.prepend(minus);
    $("lines").append(row);
  }

  const items = [...basket].map(([id, qty]) => ({ id, qty }));
  let total = 0;
  try {
    total = basketTotalOre(items, products);
  } catch {
    total = 0;
  }
  $("total").textContent = `${formatOre(total)} kr`;
  const configured = Boolean(settings?.storeName && settings?.payeeNumber);
  $("buyBtn").disabled = inFlight || items.length === 0 || !configured;
  return { items, total };
}

function renderAll() {
  $("storeName").textContent = settings?.storeName || "Swish-kassa";
  renderProducts();
  renderBasket();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// --- charging --------------------------------------------------------------

$("buyBtn").onclick = async () => {
  const { items, total } = renderBasket();
  if (!items.length) return;
  // Disable immediately: the chargeId makes a retry safe, but not showing two
  // spinners is better than relying on it.
  inFlight = true;
  $("buyBtn").disabled = true;
  $("error").textContent = "";
  try {
    const res = await api("POST", "/api/charge", {
      chargeId: crypto.randomUUID(),
      items,
      expectedTotalOre: total,
    });
    $("qrAmount").textContent = `${formatOre(res.totalOre)} kr`;
    $("qrNote").textContent = res.message;
    $("qrHolder").innerHTML = res.svg;
    $("qrDlg").showModal();
  } catch (err) {
    $("error").textContent = ERRORS[err.message] ?? "Kunde inte skapa betalning.";
    if (err.message === "stale_total" || err.message === "unknown_product") await refresh();
  } finally {
    inFlight = false;
    renderBasket();
  }
};

async function endCharge() {
  $("qrDlg").close();
  basket.clear();
  renderAll();
  try {
    await api("POST", "/api/idle");
  } catch { /* the display will resync on its next event */ }
}
$("doneCharge").onclick = endCharge;
$("cancelCharge").onclick = endCharge;

// --- settings --------------------------------------------------------------

function productRow(p = { id: crypto.randomUUID(), name: "", priceOre: 0 }) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = p.id;
  row.innerHTML =
    `<input class="name" value="${escapeHtml(p.name)}" placeholder="Namn">` +
    `<input class="price" inputmode="decimal" value="${p.priceOre ? formatOre(p.priceOre) : ""}" placeholder="0,00">`;
  const del = document.createElement("button");
  del.className = "icon-btn";
  del.textContent = "✕";
  del.onclick = () => row.remove();
  row.append(del);
  return row;
}

$("settingsBtn").onclick = () => {
  $("fName").value = settings?.storeName ?? "";
  $("fPayee").value = settings?.payeeNumber ?? "";
  $("productRows").innerHTML = "";
  const sorted = [...products].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const p of sorted.length ? sorted : [undefined]) {
    $("productRows").append(productRow(p));
  }
  $("settingsError").textContent = "";
  $("settingsDlg").showModal();
};
$("addRow").onclick = () => $("productRows").append(productRow());
$("cancelSettings").onclick = () => $("settingsDlg").close();

$("saveSettings").onclick = async () => {
  $("settingsError").textContent = "";
  const rows = [...$("productRows").children];
  const next = [];
  try {
    rows.forEach((row, i) => {
      const name = row.querySelector(".name").value.trim();
      const priceRaw = row.querySelector(".price").value.trim();
      if (!name && !priceRaw) return;
      if (!name) throw new Error("Alla produkter behöver ett namn.");
      next.push({ id: row.dataset.id, name, priceOre: parseKronorToOre(priceRaw), sortOrder: i });
    });
  } catch (err) {
    $("settingsError").textContent = err.message === "invalid_amount"
      ? "Ett pris är ogiltigt. Skriv t.ex. 19,90."
      : err.message;
    return;
  }

  try {
    // Settings first: a bad payee must not leave products half-saved silently.
    await api("PUT", "/api/settings", {
      storeName: $("fName").value.trim(),
      payeeNumber: $("fPayee").value.trim(),
    });
    await api("PUT", "/api/products", next);
  } catch (err) {
    $("settingsError").textContent = err.message === "invalid_payee"
      ? "Swish-numret ser inte giltigt ut."
      : err.message === "invalid_store_name"
      ? "Ange ett butiksnamn."
      : "Kunde inte spara. Försök igen.";
    return; // The dialog stays open: never show a saved state we did not achieve.
  }
  $("settingsDlg").close();
  await refresh();
};

// --- pairing ---------------------------------------------------------------

$("pairBtn").onclick = async () => {
  $("displayUrl").textContent = `${location.origin}/display.html`;
  $("pairCode").textContent = "······";
  $("pairExpiry").textContent = "";
  $("pairDlg").showModal();
  try {
    const { code } = await api("POST", "/api/pair");
    $("pairCode").textContent = code;
    $("pairExpiry").textContent = "Koden gäller i 5 minuter och kan bara användas en gång.";
  } catch {
    $("pairCode").textContent = "fel";
  }
};
$("closePair").onclick = () => $("pairDlg").close();

// --- live connection -------------------------------------------------------

async function connect() {
  try {
    const { ticket } = await api("POST", "/api/stream-ticket");
    const es = new EventSource(`/api/events?ticket=${encodeURIComponent(ticket)}`);
    es.addEventListener("presence", (e) => {
      $("dot").classList.toggle("on", JSON.parse(e.data).displays > 0);
    });
    es.onerror = () => {
      $("dot").classList.remove("on");
      es.close();
      // A ticket is single-use, so a reconnect needs a fresh one. EventSource's
      // own retry cannot do that for us.
      setTimeout(connect, 3000);
    };
  } catch {
    setTimeout(connect, 5000);
  }
}

// --- boot ------------------------------------------------------------------

async function refresh() {
  const state = await api("GET", "/api/state");
  settings = state.settings;
  products = state.products;
  for (const id of [...basket.keys()]) {
    if (!products.some((p) => p.id === id)) basket.delete(id);
  }
  renderAll();
}

async function boot() {
  if (!room) {
    const res = await fetch("/api/rooms", { method: "POST" });
    room = await res.json();
    localStorage.setItem(LS, JSON.stringify(room));
  }
  await refresh();
  connect();
  if (!settings?.storeName) $("settingsBtn").click();
}

boot();
