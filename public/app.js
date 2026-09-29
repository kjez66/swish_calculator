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
  if (!res.ok) {
    throw Object.assign(new Error(data.error ?? "fel"), { data, status: res.status });
  }
  return data;
}

const ERRORS = {
  not_configured: "Ange butiksnamn och Swish-nummer i inställningar.",
  empty_basket: "Korgen är tom.",
  unknown_product: "En produkt i korgen finns inte längre. Uppdaterar listan.",
  bad_quantity: "Ogiltigt antal.",
  amount_too_low: "Beloppet är under 1 kr.",
  amount_too_high: "Beloppet är orimligt högt. Kontrollera korgen.",
  stale_total: "Priserna har ändrats. Kontrollera summan och tryck Ta betalt igen.",
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
      `<span>${escapeHtml(p.name)}</span><span class="price">${
        formatOre(p.priceOre)
      }</span>` +
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
    row.innerHTML = `<span class="name">${qty} × ${escapeHtml(p.name)}</span>` +
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
  // The operator's verb is "take payment", and the amount on the button saves a
  // glance up at the total. On slow market data, say that something is happening.
  $("buyBtn").textContent = inFlight
    ? "Skapar QR…"
    : items.length
    ? `Ta betalt ${formatOre(total)} kr`
    : "Ta betalt";
  return { items, total };
}

function renderAll() {
  $("storeName").textContent = settings?.storeName || "Swish-kassa";
  renderProducts();
  renderBasket();
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// --- charging --------------------------------------------------------------

$("buyBtn").onclick = async () => {
  const { items, total } = renderBasket();
  if (!items.length) return;
  // Disable immediately: the chargeId makes a retry safe, but not showing two
  // spinners is better than relying on it.
  inFlight = true;
  renderBasket();
  $("error").textContent = "";
  try {
    const res = await api("POST", "/api/charge", {
      chargeId: crypto.randomUUID(),
      items,
      expectedTotalOre: total,
    });
    showCharge(res);
  } catch (err) {
    $("error").textContent = ERRORS[err.message] ?? "Kunde inte skapa betalning.";
    if (err.message === "stale_total" || err.message === "unknown_product") {
      await safeRefresh();
    }
  } finally {
    inFlight = false;
    renderBasket();
  }
};

/**
 * Fill the QR dialog from a charge (the POST response or a `state` event) and
 * open it. The live event and the POST response for the same charge race each
 * other, so whichever arrives second must not call showModal() again.
 */
function showCharge(c) {
  $("qrAmount").textContent = `${formatOre(c.totalOre)} kr`;
  $("qrNote").textContent = c.message;
  $("qrHolder").innerHTML = c.svg;
  if (!$("qrDlg").open) {
    // Esc and the back gesture close without setting returnValue, so clear the
    // previous dismissal's reason: an unset reason must read as a cancel.
    $("qrDlg").returnValue = "";
    $("qrDlg").showModal();
  }
}

// Why the QR dialog closed, read from its returnValue in the close handler:
// "paid"   – Klar: the basket is done, and the display thanks the customer.
// "server" – the server already went idle; do not post /api/idle again.
// ""       – Avbryt, Esc or the back gesture: a cancel, which keeps the basket,
//            because "wait, add a bun" must not mean ringing up everything again.
async function endCharge() {
  const reason = $("qrDlg").returnValue;
  if (reason === "paid") {
    basket.clear();
    renderAll();
  }
  if (reason === "server") return;
  try {
    await api("POST", "/api/idle", reason === "paid" ? { paid: true } : undefined);
  } catch { /* the display will resync on its next event */ }
}
$("qrDlg").addEventListener("close", endCharge);
$("doneCharge").onclick = () => $("qrDlg").close("paid");
$("cancelCharge").onclick = () => $("qrDlg").close();

// --- settings --------------------------------------------------------------

// A new row has no price (null), so it stays blank and an untouched blank row
// is skipped on save. A saved price of 0 renders as "0,00": left empty, saving
// that named row would fail as an invalid price.
function productRow(p = { id: crypto.randomUUID(), name: "", priceOre: null }) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = p.id;
  row.innerHTML =
    `<input class="name" value="${escapeHtml(p.name)}" placeholder="Namn">` +
    `<input class="price" inputmode="decimal" value="${
      Number.isInteger(p.priceOre) ? formatOre(p.priceOre) : ""
    }" placeholder="0,00">`;
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
      next.push({
        id: row.dataset.id,
        name,
        priceOre: parseKronorToOre(priceRaw),
        sortOrder: i,
      });
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
  await safeRefresh();
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
    $("pairExpiry").textContent =
      "Koden gäller i 5 minuter och kan bara användas en gång.";
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
    // The first `state` event replays the room's current state. The basket and
    // the QR dialog live only in page memory, so after a reload (or a mobile
    // browser discarding the backgrounded tab) this is what brings back an open
    // charge and its Klar/Avbryt. Without it the display keeps a payable QR
    // that nothing on this page can clear.
    es.addEventListener("state", (e) => {
      const s = JSON.parse(e.data);
      if (s.state === "charge") {
        if (!$("qrDlg").open) showCharge(s);
      } else if ($("qrDlg").open) {
        $("qrDlg").close("server");
      }
    });
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

async function safeRefresh() {
  try {
    await refresh();
  } catch {
    $("error").textContent = "Kunde inte hämta data. Kontrollera anslutningen.";
  }
}

async function createRoom() {
  const res = await fetch("/api/rooms", { method: "POST" });
  if (!res.ok) throw new Error("rooms");
  room = await res.json();
  localStorage.setItem(LS, JSON.stringify(room));
}

async function boot() {
  try {
    if (!room) await createRoom();
    try {
      await refresh();
    } catch (err) {
      if (err.status !== 401) throw err;
      // The server no longer knows this room: start over once, without looping.
      localStorage.removeItem(LS);
      await createRoom();
      await refresh();
    }
  } catch {
    $("error").textContent = "Kunde inte ansluta till servern. Ladda om sidan.";
    return;
  }
  connect();
  if (!settings?.storeName) $("settingsBtn").click();
}

boot();
