import { CATEGORIES, categoryName } from "/shared/categories.js";
import { basketTotalOre, formatOre, parseKronorToOre } from "/shared/money.js";
import { salesReportPdf } from "/shared/report-pdf.js";
import { summarizeSales } from "/shared/sales.js";

const $ = (id) => document.getElementById(id);
const LS = "swish-kassa-room";

let room = JSON.parse(localStorage.getItem(LS) ?? "null");
let settings = null;
let products = [];
let stateLoaded = false;
/** @type {Map<string, number>} product id -> quantity */
const basket = new Map();
let inFlight = false;
// Whether the basket lines are shown. Closed by default, and closed again
// whenever the basket empties, so every sale starts with the products in view.
let linesOpen = false;

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
  unknown_product:
    "En produkt i korgen finns inte längre eller är avstängd. " + "Uppdaterar listan.",
  bad_quantity: "Ogiltigt antal.",
  amount_too_low: "Beloppet är under 1 kr.",
  amount_too_high: "Beloppet är orimligt högt. Kontrollera korgen.",
  stale_total: "Priserna har ändrats. Kontrollera summan och tryck Ta betalt igen.",
  charge_in_progress: "En betalning behandlas redan. Försök igen.",
  rate_limited: "För många försök. Vänta en minut.",
};

// --- rendering -------------------------------------------------------------

/** Disabled products stay in settings but are not for sale. No flag means on. */
const isEnabled = (p) => p.enabled !== false;

function renderProducts() {
  $("grid").innerHTML = "";
  const forSale = products.filter(isEnabled);
  if (!forSale.length) {
    // An empty grid with no hint looks broken; say what to do instead.
    const [text, action] = products.length
      ? ["Alla produkter är avstängda.", "Slå på produkter"]
      : ["Inga produkter än.", "Lägg till produkter"];
    $("grid").innerHTML =
      `<div class="empty"><p>${text}</p>` +
      `<button class="icon-btn" id="emptyAdd">${action}</button></div>`;
    $("emptyAdd").onclick = openSettings;
    return;
  }
  for (const p of forSale.sort((a, b) => a.sortOrder - b.sortOrder)) {
    const qty = basket.get(p.id) ?? 0;
    const btn = document.createElement("button");
    btn.className = "product";
    btn.dataset.focus = `tile:${p.id}`;
    // The category tints the tile, and is said too, so colour is not the only cue.
    // It comes after the name and price, so the label starts with what the tile
    // shows and voice control finds it by saying that (WCAG 2.5.3).
    const category = categoryName(p.category);
    if (category) btn.dataset.category = p.category;
    btn.setAttribute(
      "aria-label",
      `${p.name}, ${formatOre(p.priceOre)} kr${category ? `, ${category}` : ""}${
        qty ? `, ${qty} i korgen` : ""
      }`,
    );
    btn.innerHTML =
      `<span>${escapeHtml(p.name)}</span><span class="price">${formatOre(
        p.priceOre,
      )}</span>` + (qty ? `<span class="qty">${qty}</span>` : "");
    btn.onclick = () => changeQty(p.id, +1);
    $("grid").append(btn);
  }
}

// A short buzz confirms a tap without looking (Android; iOS has no vibrate API).
function tapFeedback() {
  navigator.vibrate?.(10);
}

/** Add or remove one of a product, and say the result for screen readers. */
function changeQty(id, delta) {
  tapFeedback();
  const qty = (basket.get(id) ?? 0) + delta;
  if (qty > 0) basket.set(id, qty);
  else basket.delete(id);
  const { total } = renderAll();
  const p = products.find((x) => x.id === id);
  announce(`${p.name}: ${qty} i korgen. Totalt ${formatOre(total)} kr.`);
}

// Spoken by screen readers via the role="status" region (WCAG 4.1.3).
function announce(message) {
  // Clear first, so the same message twice in a row is still announced.
  $("announce").textContent = "";
  setTimeout(() => ($("announce").textContent = message), 50);
}

function renderBasket() {
  $("lines").innerHTML = "";
  for (const [id, qty] of basket) {
    const p = products.find((x) => x.id === id);
    if (!p) continue;
    const row = document.createElement("div");
    row.className = "line";
    const name = escapeHtml(p.name);
    row.innerHTML =
      `<span class="name">${name}</span>` +
      `<button class="minus" data-focus="minus:${id}" aria-label="En ${name} mindre">−</button>` +
      `<span class="qty-n">${qty}</span>` +
      `<button class="plus" data-focus="plus:${id}" aria-label="En ${name} till">+</button>` +
      `<span class="sum">${formatOre(p.priceOre * qty)}</span>`;
    row.querySelector(".minus").onclick = () => changeQty(id, -1);
    row.querySelector(".plus").onclick = () => changeQty(id, +1);
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
  const count = items.reduce((n, item) => n + item.qty, 0);
  if (!count) linesOpen = false;
  $("totalLabel").hidden = count > 0;
  $("linesToggle").hidden = count === 0;
  $("itemCount").textContent = `${count} ${count === 1 ? "vara" : "varor"}`;
  $("linesToggle").setAttribute("aria-expanded", String(linesOpen));
  $("lines").hidden = !linesOpen;
  const configured = Boolean(settings?.storeName && settings?.payeeNumber);
  // Not before the first /api/state answer: until then nobody knows yet.
  $("setupHint").hidden = configured || !stateLoaded;
  $("buyBtn").disabled = inFlight || items.length === 0 || !configured;
  $("clearBtn").disabled = inFlight || items.length === 0;
  // The operator's verb is "take payment", and the amount on the button saves a
  // glance up at the total. On slow market data, say that something is happening.
  $("buyBtn").classList.toggle("loading", inFlight); // spinner via CSS
  $("buyBtn").textContent = inFlight
    ? "Skapar QR…"
    : items.length
      ? `Ta betalt ${formatOre(total)} kr`
      : "Ta betalt";
  return { items, total };
}

// Re-rendering replaces the buttons, which would drop keyboard focus onto
// <body> on every tap (WCAG 2.4.3). Put it back on the same control; when a
// basket line disappears (quantity 0), fall back to that product's tile.
function renderAll() {
  const focused = document.activeElement?.dataset?.focus;
  $("storeName").textContent = settings?.storeName || "Swish-kassa";
  renderProducts();
  const result = renderBasket();
  if (focused) {
    const id = focused.slice(focused.indexOf(":") + 1);
    const target =
      document.querySelector(`[data-focus="${CSS.escape(focused)}"]`) ??
      document.querySelector(`[data-focus="${CSS.escape(`tile:${id}`)}"]`);
    target?.focus();
  }
  return result;
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
  closedOrderNo = null;
  renderBasket();
  $("error").textContent = "";
  try {
    await idleDone;
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
  if (c.orderNo === closedOrderNo) return;
  shownOrderNo = c.orderNo;
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
    // The dialog hands focus back to "Ta betalt", which is now disabled (empty
    // basket), so a keyboard user would land on <body>. Start at the products.
    document.querySelector(".product")?.focus();
    announce("Betalningen avslutad. Korgen är tom.");
  }
  if (reason === "server") return;
  idleDone = api(
    "POST",
    "/api/idle",
    reason === "paid" ? { paid: true } : undefined,
  ).catch(() => {
    /* the display will resync on its next event */
  });
  await idleDone;
}
// The last /api/idle request. A new charge waits for it: otherwise a quick
// operator's next charge can reach the server first, and the late idle would
// then wipe the new QR off the display (and close its dialog here).
let idleDone = Promise.resolve();
$("qrDlg").addEventListener("close", endCharge);
// The live `state` event and the POST response both show the charge, in either
// order, and the later one can arrive after the operator has already closed it
// (a slow network, a replay on reconnect). Reopening would clear returnValue
// before the close handler reads it and turn the Klar just pressed into a
// cancel: no sale saved, basket kept. So showCharge leaves a closed charge
// closed. Marked synchronously, because the close event fires a task later;
// cleared by the next charge, since order numbers restart every day.
let shownOrderNo = null;
let closedOrderNo = null;
const markClosed = () => (closedOrderNo = shownOrderNo);
$("qrDlg").addEventListener("cancel", markClosed); // Esc and the back gesture
$("doneCharge").onclick = () => {
  markClosed();
  $("qrDlg").close("paid");
};
$("cancelCharge").onclick = () => {
  markClosed();
  $("qrDlg").close();
};

// --- showing the basket lines ----------------------------------------------

$("linesToggle").onclick = () => {
  linesOpen = !linesOpen;
  renderBasket();
};

// --- emptying the basket ---------------------------------------------------

// The customer changed their mind: everything goes, but only after asking.
$("clearBtn").onclick = () => $("clearDlg").showModal();
$("keepBasket").onclick = () => $("clearDlg").close();
$("confirmClear").onclick = () => {
  $("clearDlg").close();
  basket.clear();
  $("error").textContent = "";
  renderAll();
  // The dialog hands focus back to the trash button, now disabled, so a
  // keyboard user would land on <body>. Start at the products instead.
  document.querySelector(".product")?.focus();
  announce("Korgen är tömd.");
};

// --- settings --------------------------------------------------------------

/** The Kategori list's options, with the product's category selected. */
const categoryOptions = (selected) =>
  `<option value="">Ingen</option>` +
  CATEGORIES.map(
    ({ id, name }) =>
      `<option value="${id}"${id === selected ? " selected" : ""}>${name}</option>`,
  ).join("");

// A new row has no price (null), so it stays blank and an untouched blank row
// is skipped on save. A saved price of 0 renders as "0,00": left empty, saving
// that named row would fail as an invalid price.
// Three lines per product, so the name gets the full width on a phone and the
// price, reorder and delete buttons can all be 44px targets.
// The third picks the category that tints the product's tile.
// The "Aktiv" switch takes a product off the till without losing its name,
// price and place, e.g. when the buns run out.
function productRow(p = { id: crypto.randomUUID(), name: "", priceOre: null }) {
  const row = document.createElement("div");
  row.className = "product-row";
  row.dataset.id = p.id;
  // Visible "Namn" and "Pris … kr" labels: a placeholder alone disappears once
  // typed in (WCAG 3.3.2). Each aria-label contains its visible label (2.5.3).
  row.innerHTML =
    `<div class="row"><span class="unit" aria-hidden="true">Namn</span>` +
    `<input class="name" value="${escapeHtml(p.name)}" aria-label="Namn">` +
    `<label class="toggle" title="Visa produkten i kassan">` +
    `<input type="checkbox" class="enabled" role="switch"${
      isEnabled(p) ? " checked" : ""
    }>Aktiv</label></div>` +
    `<div class="row"><span class="unit" aria-hidden="true">Pris</span>` +
    `<input class="price" inputmode="decimal" value="${
      Number.isInteger(p.priceOre) ? formatOre(p.priceOre) : ""
    }" placeholder="0,00" aria-label="Pris i kronor">` +
    `<span class="unit" aria-hidden="true">kr</span>` +
    `<button class="icon-btn up" aria-label="Flytta upp" title="Flytta upp">↑</button>` +
    `<button class="icon-btn down" aria-label="Flytta ned" title="Flytta ned">↓</button>` +
    `<button class="icon-btn del" aria-label="Ta bort produkt" title="Ta bort produkt">` +
    `✕</button>` +
    `</div>` +
    `<div class="row"><span class="unit" aria-hidden="true">Kategori</span>` +
    `<select class="category" aria-label="Kategori">${categoryOptions(p.category)}</select>` +
    `<span class="swatch" aria-hidden="true"></span></div>`;
  // Moving or removing a row takes the pressed button out of the DOM, which
  // drops keyboard focus; keep it on the button (or, after a delete, on the
  // nearest remaining row) so the next key press does what the user expects.
  const move = (btn, where) => {
    const sibling = where === "up" ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    if (where === "up") sibling.before(row);
    else sibling.after(row);
    btn.focus();
    announce(where === "up" ? "Flyttad upp" : "Flyttad ned");
  };
  row.querySelector(".price").oninput = (e) => sanitizePrice(e.currentTarget);
  const enabled = row.querySelector(".enabled");
  const syncOff = () => row.classList.toggle("off", !enabled.checked);
  enabled.onchange = syncOff;
  syncOff();
  const category = row.querySelector(".category");
  const swatch = row.querySelector(".swatch");
  const syncSwatch = () => {
    if (category.value) swatch.dataset.category = category.value;
    else swatch.removeAttribute("data-category");
  };
  category.onchange = syncSwatch;
  syncSwatch();
  row.querySelector(".up").onclick = (e) => move(e.currentTarget, "up");
  row.querySelector(".down").onclick = (e) => move(e.currentTarget, "down");
  row.querySelector(".del").onclick = () => {
    const next = row.nextElementSibling ?? row.previousElementSibling;
    row.remove();
    (next?.querySelector(".name") ?? $("addRow")).focus();
    announce("Produkten borttagen");
  };
  return row;
}

// A price field takes only digits and one decimal comma (a typed dot becomes
// one) with at most two decimals, so letters never get as far as Spara.
// Assigning the value moves the caret to the end, so only do it on a change.
function sanitizePrice(input) {
  const [, kronor, decimals] = /^(\d*)(?:[.,](\d{0,2}))?/.exec(
    input.value.replace(/[^\d.,]/g, ""),
  );
  const clean = decimals === undefined ? kronor : `${kronor},${decimals}`;
  if (clean !== input.value) input.value = clean;
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
      const category = row.querySelector(".category").value;
      next.push({
        id: row.dataset.id,
        name,
        priceOre: parseKronorToOre(priceRaw),
        sortOrder: i,
        enabled: row.querySelector(".enabled").checked,
        // Ingen is told by leaving the key out; the server refuses "".
        ...(category ? { category } : {}),
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
      fieldError(
        $("fPayee"),
        "Numret ser inte giltigt ut. Skriv t.ex. 070-123 45 67.",
      ).focus();
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

// --- sales log -------------------------------------------------------------

const STOCKHOLM = "Europe/Stockholm";
// The server files a sale under its Stockholm date; "today" must agree.
const stockholmDay = (ms) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: STOCKHOLM }).format(new Date(ms));
const todayInStockholm = () => stockholmDay(Date.now());
/**
 * A YYYY-MM-DD day as the date list shows it, with today and yesterday marked.
 * Yesterday is counted on the calendar in UTC, so a summer-time change cannot
 * skip or repeat a day.
 */
function dayLabel(day) {
  const today = todayInStockholm();
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 24 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);
  return day + (day === today ? " (idag)" : day === yesterday ? " (igår)" : "");
}
const clockTime = (ms) =>
  new Date(ms).toLocaleTimeString("sv-SE", {
    timeZone: STOCKHOLM,
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Hand the browser a file to save: a download on Android and computers, the
 * preview (with Save and Share) on an iPhone.
 */
function saveFile(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  // Inside the open dialog: the rest of the page is inert behind it.
  $("salesDlg").append(a);
  a.click();
  a.remove();
  // Not revoked at once: Safari reads the file after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * One sale in "Alla köp", with its Ta bort. Removing takes a second tap on a
 * confirm button in the same place: a Klar undone by mistake cannot be redone.
 */
function saleItem(sale, date) {
  const n = sale.orderNo;
  const li = document.createElement("li");
  li.innerHTML =
    `<div class="order-head"><span>#${n} · ${clockTime(sale.paidAt)}</span>` +
    `<span>${formatOre(sale.totalOre)} kr</span></div>` +
    `<div class="order-lines">${sale.lines
      .map((l) => `${l.qty} × ${escapeHtml(l.name)}`)
      .join(", ")}</div><div class="order-actions"></div>`;
  const actions = li.querySelector(".order-actions");

  const showRemove = () => {
    actions.innerHTML = `<button class="link-btn del-sale" aria-label="Ta bort köp #${n}">Ta bort</button>`;
    actions.querySelector(".del-sale").onclick = showConfirm;
  };
  const showConfirm = () => {
    actions.innerHTML =
      `<span class="confirm-q">Ta bort köp #${n}?</span>` +
      `<button class="icon-btn keep">Behåll</button>` +
      `<button class="icon-btn danger-btn confirm">Ta bort</button>`;
    const confirm = actions.querySelector(".confirm");
    actions.querySelector(".keep").onclick = () => {
      showRemove();
      actions.querySelector(".del-sale").focus();
    };
    confirm.onclick = async () => {
      confirm.disabled = true;
      try {
        await api("DELETE", `/api/sales?date=${date}&orderNo=${n}`);
      } catch (err) {
        // Already gone (another phone, or a retry) is the outcome wanted.
        if (err.message !== "sale_not_found") {
          confirm.disabled = false;
          actions.querySelector(".confirm-q").textContent =
            "Kunde inte ta bort. Försök igen.";
          return;
        }
      }
      await loadSales({ afterRemoving: n });
    };
    confirm.focus();
  };

  showRemove();
  return li;
}

/**
 * @param {{afterRemoving?: number, dayEmptied?: boolean}} [options]
 *   afterRemoving: the order number just removed; dayEmptied: that removal
 *   emptied its day, so the list moved to another day
 */
async function loadSales({ afterRemoving, dayEmptied } = {}) {
  const date = $("salesDate").value || todayInStockholm();
  // After a removal the list stays put until the new one is in, rather than
  // flashing "Hämtar…" under the operator's thumb.
  if (!afterRemoving) $("salesBody").innerHTML = `<p class="note">Hämtar…</p>`;
  let sales;
  try {
    ({ sales } = await api("GET", `/api/sales?date=${date}`));
  } catch {
    $("salesBody").innerHTML = `<p class="err">Kunde inte hämta försäljningen.</p>`;
    return;
  }
  // A slower answer for a date the user has since changed away from.
  if (($("salesDate").value || todayInStockholm()) !== date) return;
  const summary = summarizeSales(sales);
  // The day just emptied leaves the date list.
  if (!sales.length && afterRemoving && !dayEmptied) {
    return showSalesDays({ afterRemoving });
  }
  const said =
    (dayEmptied ? `Visar ${date}. ` : "") +
    `${summary.count} köp, totalt ${formatOre(summary.totalOre)} kr.`;
  // Spoken from inside the dialog: the page's own status region is inert
  // behind a modal. The table itself is not read out on every load.
  $("salesAnnounce").textContent = afterRemoving
    ? `Köp #${afterRemoving} borttaget. ${said}`
    : said;
  if (!sales.length) {
    // A day another phone emptied after the date list was built.
    $("salesBody").innerHTML = `<p class="note sales-total">Inga köp detta datum.</p>`;
    return;
  }
  const rows = summary.products
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.name)}</td><td>${p.qty}</td>` +
        `<td>${formatOre(p.totalOre)}</td></tr>`,
    )
    .join("");
  $("salesBody").innerHTML =
    `<div class="sales-total"><span>${summary.count} köp</span>` +
    `<b>${formatOre(summary.totalOre)} kr</b></div>` +
    `<table class="sales-table"><thead><tr><th scope="col">Produkt</th>` +
    `<th scope="col">Antal</th><th scope="col">Summa (kr)</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    `<button class="icon-btn sales-pdf">Ladda ner PDF</button>` +
    `<details class="sales-orders"><summary>Alla köp (${summary.count})</summary>` +
    `<ol></ol></details>`;
  $("salesBody").querySelector(".sales-pdf").onclick = () =>
    saveFile(
      salesReportPdf({
        storeName: settings?.storeName ?? "",
        date,
        summary,
        createdAt: Date.now(),
      }),
      `forsaljning-${date}.pdf`,
      "application/pdf",
    );
  // Latest first: after a match, the last sales are the ones to check.
  const list = $("salesBody").querySelector("ol");
  for (const sale of [...sales].reverse()) list.append(saleItem(sale, date));
  if (dayEmptied) {
    // The removed row went with its day; focus where the new day was picked.
    $("salesDate").focus();
  } else if (afterRemoving) {
    // The removed row's buttons are gone; keep the list open and focus in it.
    const details = $("salesBody").querySelector("details");
    details.open = true;
    details.querySelector("summary").focus();
  }
}

/**
 * Fill the date list with the days that have sales, newest first, and show the
 * newest. With none in the last 31 days there is nothing to pick: the list is
 * hidden and the dialog says so.
 * @param {{afterRemoving?: number}} [options] the order number just removed
 */
async function showSalesDays({ afterRemoving } = {}) {
  const picker = [$("salesDateLabel"), $("salesDate")];
  if (!afterRemoving) {
    for (const el of picker) el.hidden = true;
    $("salesBody").innerHTML = `<p class="note">Hämtar…</p>`;
  }
  let days;
  try {
    ({ days } = await api("GET", "/api/sales/days"));
  } catch {
    $("salesBody").innerHTML = `<p class="err">Kunde inte hämta försäljningen.</p>`;
    return;
  }
  for (const el of picker) el.hidden = !days.length;
  if (!days.length) {
    const none = "Inga köp de senaste 31 dagarna.";
    $("salesBody").innerHTML = `<p class="note sales-total">${none}</p>`;
    $("salesAnnounce").textContent =
      (afterRemoving ? `Köp #${afterRemoving} borttaget. ` : "") + none;
    if (afterRemoving) $("closeSales").focus();
    return;
  }
  $("salesDate").innerHTML = days
    .map((day) => `<option value="${day}">${dayLabel(day)}</option>`)
    .join("");
  await loadSales({ afterRemoving, dayEmptied: Boolean(afterRemoving) });
}

// Rebuilt on every opening, so new sales and a new day show up.
$("salesBtn").onclick = () => {
  $("salesDlg").showModal();
  showSalesDays();
};
$("salesDate").onchange = loadSales;
$("closeSales").onclick = () => $("salesDlg").close();

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

// A "presence" question every 15 s keeps the display status current, and its
// answer doubles as the heartbeat (the display, which has no such question,
// sends "ping" instead). No message at all between two questions means the
// connection is dead even if the socket never said so (a phone that lost its
// network), so close it and reconnect.
const PING_MS = 15_000;
// Deadlines for getting back on: on Wi-Fi without internet, or a connection
// that died with the network, a request or a new socket can hang for minutes.
const TICKET_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 10_000;

async function connect() {
  let ws;
  try {
    // A browser WebSocket cannot send headers: the token buys a one-time ticket.
    // A late answer after the timeout is simply ignored.
    const { ticket } = await Promise.race([
      api("POST", "/api/stream-ticket"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), TICKET_TIMEOUT_MS),
      ),
    ]);
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(
      `${scheme}://${location.host}/api/events?roomId=${room.roomId}` +
        `&ticket=${encodeURIComponent(ticket)}`,
    );
  } catch {
    setStatus("offline");
    setTimeout(connect, 5000);
    return;
  }
  let alive = true;
  let timer = 0;
  let ended = false;
  // Reconnect at once rather than wait for onclose: on a dead network the
  // closing handshake cannot finish, and the browser may report the close
  // much later. The old socket's own close is then ignored.
  const restart = () => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    clearTimeout(deadline);
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    setStatus("offline");
    // A ticket is single-use, so a reconnect goes through a fresh one.
    setTimeout(connect, 3000);
  };
  // A socket that never opens is as dead as one that stopped answering.
  const deadline = setTimeout(restart, CONNECT_TIMEOUT_MS);
  ws.onopen = () => {
    clearTimeout(deadline);
    // "hello" replays the kassa's current state. The basket and the QR dialog
    // live only in page memory, so after a reload (or a mobile browser
    // discarding the backgrounded tab) this is what brings back an open charge
    // and its Klar/Avbryt. Without it the display keeps a payable QR that
    // nothing on this page can clear.
    ws.send("hello");
    timer = setInterval(() => {
      if (!alive) return restart();
      alive = false;
      ws.send("presence");
    }, PING_MS);
  };
  ws.onmessage = (e) => {
    alive = true;
    if (e.data === "pong") return;
    const { event, data } = JSON.parse(e.data);
    if (event === "state") {
      if (data.state === "charge") {
        if (!$("qrDlg").open) showCharge(data);
      } else if ($("qrDlg").open) {
        $("qrDlg").close("server");
      }
    } else if (event === "presence") {
      setStatus(data.displays > 0 ? "display" : "none");
    }
  };
  ws.onclose = restart;
}

// The header's status button says in words what the dot's colour means.
const STATUS = {
  display: { text: "Display ansluten", dot: "on" },
  none: { text: "Ingen display", dot: "" },
  offline: { text: "Ingen anslutning", dot: "offline" },
};
let lastStatus = null;
function setStatus(kind) {
  $("dotText").textContent = STATUS[kind].text;
  $("dot").className = `dot ${STATUS[kind].dot}`;
  // Spoken only on a real change: presence repeats with every heartbeat.
  if (lastStatus !== null && kind !== lastStatus) announce(STATUS[kind].text);
  lastStatus = kind;
}

// --- boot ------------------------------------------------------------------

async function refresh() {
  const state = await api("GET", "/api/state");
  settings = state.settings;
  products = state.products;
  stateLoaded = true;
  for (const id of [...basket.keys()]) {
    if (!products.some((p) => p.id === id && isEnabled(p))) basket.delete(id);
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

// Keep --basket-h equal to the fixed basket's real height, so style.css's
// scroll-padding lifts keyboard-focused products clear of it (WCAG 2.4.11).
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty(
    "--basket-h",
    `${Math.ceil(entry.target.getBoundingClientRect().height)}px`,
  );
}).observe(document.querySelector(".basket"));

boot();

// Makes the page installable as an app (see sw.js). Without it, or where it
// fails, the page works exactly the same in the browser.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
