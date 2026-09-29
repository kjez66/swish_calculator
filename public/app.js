import { basketTotalOre, formatOre, parseKronorToOre } from "/shared/money.js";

const $ = (id) => document.getElementById(id);
const LS = "swish-kassa-room";

let room = JSON.parse(localStorage.getItem(LS) ?? "null");
let settings = null;
let products = [];
let stateLoaded = false;
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
  if (!products.length) {
    // An empty grid with no hint looks broken; say what to do instead.
    $("grid").innerHTML = `<div class="empty"><p>Inga produkter än.</p>` +
      `<button class="icon-btn" id="emptyAdd">Lägg till produkter</button></div>`;
    $("emptyAdd").onclick = openSettings;
    return;
  }
  for (const p of [...products].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const qty = basket.get(p.id) ?? 0;
    const btn = document.createElement("button");
    btn.className = "product";
    btn.setAttribute(
      "aria-label",
      `${p.name}, ${formatOre(p.priceOre)} kr${qty ? `, ${qty} i korgen` : ""}`,
    );
    btn.innerHTML =
      `<span>${escapeHtml(p.name)}</span><span class="price">${
        formatOre(p.priceOre)
      }</span>` +
      (qty ? `<span class="qty">${qty}</span>` : "");
    btn.onclick = () => {
      tapFeedback();
      basket.set(p.id, qty + 1);
      renderAll();
    };
    $("grid").append(btn);
  }
}

// A short buzz confirms a tap without looking (Android; iOS has no vibrate API).
function tapFeedback() {
  navigator.vibrate?.(10);
}

function renderBasket() {
  $("lines").innerHTML = "";
  for (const [id, qty] of basket) {
    const p = products.find((x) => x.id === id);
    if (!p) continue;
    const row = document.createElement("div");
    row.className = "line";
    const name = escapeHtml(p.name);
    row.innerHTML = `<span class="name">${name}</span>` +
      `<button class="minus" aria-label="En ${name} mindre">−</button>` +
      `<span class="qty-n">${qty}</span>` +
      `<button class="plus" aria-label="En ${name} till">+</button>` +
      `<span class="sum">${formatOre(p.priceOre * qty)}</span>`;
    row.querySelector(".minus").onclick = () => {
      tapFeedback();
      const next = qty - 1;
      if (next > 0) basket.set(id, next);
      else basket.delete(id);
      renderAll();
    };
    row.querySelector(".plus").onclick = () => {
      tapFeedback();
      basket.set(id, qty + 1);
      renderAll();
    };
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
  // Not before the first /api/state answer: until then nobody knows yet.
  $("setupHint").hidden = configured || !stateLoaded;
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
// Two lines per product, so the name gets the full width on a phone and the
// price, reorder and delete buttons can all be 44px targets.
function productRow(p = { id: crypto.randomUUID(), name: "", priceOre: null }) {
  const row = document.createElement("div");
  row.className = "product-row";
  row.dataset.id = p.id;
  row.innerHTML = `<input class="name" value="${escapeHtml(p.name)}" placeholder="Namn"` +
    ` aria-label="Produktnamn">` +
    // Visible "Pris … kr" labels: a placeholder alone disappears once typed in.
    `<div class="row"><span class="unit" aria-hidden="true">Pris</span>` +
    `<input class="price" inputmode="decimal" value="${
      Number.isInteger(p.priceOre) ? formatOre(p.priceOre) : ""
    }" placeholder="0,00" aria-label="Pris i kronor">` +
    `<span class="unit" aria-hidden="true">kr</span>` +
    `<button class="icon-btn up" aria-label="Flytta upp">↑</button>` +
    `<button class="icon-btn down" aria-label="Flytta ned">↓</button>` +
    `<button class="icon-btn del" aria-label="Ta bort produkt">✕</button>` +
    `</div>`;
  row.querySelector(".up").onclick = () => row.previousElementSibling?.before(row);
  row.querySelector(".down").onclick = () => row.nextElementSibling?.after(row);
  row.querySelector(".del").onclick = () => row.remove();
  return row;
}

function openSettings() {
  $("fName").value = settings?.storeName ?? "";
  $("fPayee").value = settings?.payeeNumber ?? "";
  $("productRows").innerHTML = "";
  const sorted = [...products].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const p of sorted.length ? sorted : [undefined]) {
    $("productRows").append(productRow(p));
  }
  clearFieldErrors();
  $("settingsDlg").showModal();
}
$("settingsBtn").onclick = openSettings;
$("setupOpen").onclick = openSettings;
$("addRow").onclick = () => {
  const row = productRow();
  $("productRows").append(row);
  row.querySelector(".name").focus();
};
$("cancelSettings").onclick = () => $("settingsDlg").close();

// Errors are shown at the field they concern, not in one line at the bottom.
function clearFieldErrors() {
  $("settingsError").textContent = "";
  for (const el of $("settingsDlg").querySelectorAll(".field-err")) el.remove();
  for (const el of $("settingsDlg").querySelectorAll("[aria-invalid]")) {
    el.removeAttribute("aria-invalid");
    el.removeAttribute("aria-describedby");
  }
}

/** Mark `input` invalid and put `message` right below `after` (default: the input). */
function fieldError(input, message, after = input) {
  const msg = document.createElement("p");
  msg.className = "field-err";
  msg.id = `err-${crypto.randomUUID()}`;
  msg.textContent = message;
  after.after(msg);
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", msg.id);
  return input;
}

$("saveSettings").onclick = async () => {
  clearFieldErrors();
  const next = [];
  const invalid = [];
  [...$("productRows").children].forEach((row, i) => {
    const nameInput = row.querySelector(".name");
    const priceInput = row.querySelector(".price");
    const name = nameInput.value.trim();
    const priceRaw = priceInput.value.trim();
    if (!name && !priceRaw) return;
    if (!name) {
      invalid.push(fieldError(nameInput, "Produkten behöver ett namn.", row));
      return;
    }
    try {
      next.push({
        id: row.dataset.id,
        name,
        priceOre: parseKronorToOre(priceRaw),
        sortOrder: i,
      });
    } catch {
      invalid.push(fieldError(priceInput, "Ogiltigt pris. Skriv t.ex. 19,90.", row));
    }
  });
  if (invalid.length) {
    invalid[0].focus();
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
    if (err.message === "invalid_payee") {
      fieldError($("fPayee"), "Numret ser inte giltigt ut. Skriv t.ex. 070-123 45 67.")
        .focus();
    } else if (err.message === "invalid_store_name") {
      fieldError($("fName"), "Ange ett butiksnamn.").focus();
    } else {
      $("settingsError").textContent = "Kunde inte spara. Försök igen.";
    }
    return; // The dialog stays open: never show a saved state we did not achieve.
  }
  $("settingsDlg").close();
  await safeRefresh();
};

// --- pairing ---------------------------------------------------------------

async function openPairing() {
  $("displayUrl").textContent = `${location.origin}/display.html`;
  $("pairQr").innerHTML = "";
  $("pairCode").textContent = "Hämtar kod…";
  $("pairCode").classList.add("pending");
  $("pairExpiry").textContent = "";
  $("retryPair").hidden = true;
  if (!$("pairDlg").open) $("pairDlg").showModal();
  try {
    // The QR opens the display page with the code in it, so the display phone
    // pairs itself when scanned; the typed code is the fallback.
    const { code, pairQrSvg } = await api("POST", "/api/pair");
    $("pairQr").innerHTML = pairQrSvg;
    $("pairCode").textContent = code;
    $("pairCode").classList.remove("pending");
    $("pairExpiry").textContent =
      "Koden gäller i 5 minuter och kan bara användas en gång.";
  } catch {
    // Stays in the small "pending" style: this is a message, not a code.
    $("pairCode").textContent = "Kunde inte skapa en kod.";
    $("retryPair").hidden = false;
  }
}
$("pairBtn").onclick = openPairing;
$("retryPair").onclick = openPairing;
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
      setStatus(JSON.parse(e.data).displays > 0 ? "display" : "none");
    });
    es.onerror = () => {
      setStatus("offline");
      es.close();
      // A ticket is single-use, so a reconnect needs a fresh one. EventSource's
      // own retry cannot do that for us.
      setTimeout(connect, 3000);
    };
  } catch {
    setStatus("offline");
    setTimeout(connect, 5000);
  }
}

// The header's status button says in words what the dot's colour means.
const STATUS = {
  display: { text: "Display ansluten", dot: "on" },
  none: { text: "Ingen display", dot: "" },
  offline: { text: "Ingen anslutning", dot: "offline" },
};
function setStatus(kind) {
  $("dotText").textContent = STATUS[kind].text;
  $("dot").className = `dot ${STATUS[kind].dot}`;
}

// --- boot ------------------------------------------------------------------

async function refresh() {
  const state = await api("GET", "/api/state");
  settings = state.settings;
  products = state.products;
  stateLoaded = true;
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
    setStatus("offline");
    $("error").textContent = "Kunde inte ansluta till servern. Ladda om sidan.";
    return;
  }
  connect();
  if (!settings?.storeName) $("settingsBtn").click();
}

// iOS Safari applies :active (the pressed look on buttons and product tiles)
// only when the page has a touchstart listener.
document.addEventListener("touchstart", () => {}, { passive: true });

boot();
