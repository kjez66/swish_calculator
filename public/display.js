// deno-lint-ignore-file no-var
// Deliberately ES5 (var, no arrow functions): this page runs on an old phone.
(function () {
  var LS = "swish-kassa-display";
  var creds = null;
  try {
    creds = JSON.parse(localStorage.getItem(LS) || "null");
  } catch (_e) { /* private mode or cleared storage */ }

  var el = function (id) {
    return document.getElementById(id);
  };
  var wakeLock = null;
  var lastUpdatedAt = 0;

  // --- wake lock -----------------------------------------------------------
  // Two details decide whether this works at all: it must be acquired from a
  // user gesture, and it is auto-released whenever the page is hidden. Without
  // the re-acquire it appears to work and then silently stops.
  function requestWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
      lock.addEventListener("release", function () {
        wakeLock = null;
      });
    }).catch(function () {/* denied or unsupported */});
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && !wakeLock) requestWakeLock();
  });
  document.addEventListener("click", function () {
    if (!wakeLock) requestWakeLock();
  });

  // --- screens -------------------------------------------------------------
  function show(which) {
    el("pair").hidden = which !== "pair";
    el("idle").hidden = which !== "idle";
    el("charge").hidden = which !== "charge";
  }

  // The display runs no payment logic: the server sends the formatted amount
  // (amountText) and the rendered QR (svg) with every charge event.
  function renderState(data) {
    // Every event carries complete state, so a redelivered or out-of-order
    // event is harmless; updatedAt just stops an older one overwriting a newer.
    if (data.state === "charge") {
      if (data.updatedAt && data.updatedAt < lastUpdatedAt) return;
      lastUpdatedAt = data.updatedAt || 0;
      el("amount").textContent = data.amountText + " kr";
      el("note").textContent = data.message;
      el("qr").innerHTML = data.svg;
      show("charge");
    } else {
      lastUpdatedAt = 0;
      show("idle");
    }
  }

  // --- pairing -------------------------------------------------------------
  el("claim").addEventListener("click", function () {
    var code = el("code").value.trim();
    el("pairError").textContent = "";
    requestWakeLock(); // acquired here because this is a real user gesture
    fetch("/api/pair/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code }),
    }).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).then(function (data) {
      creds = data;
      try {
        localStorage.setItem(LS, JSON.stringify(data));
      } catch (_e) { /* storage unavailable: pairing just will not persist */ }
      show("idle");
      connect();
    }).catch(function (err) {
      el("pairError").textContent = err.message === "429"
        ? "För många försök. Vänta en minut."
        : "Fel kod, eller så har den gått ut.";
    });
  });

  // --- live connection -----------------------------------------------------
  function connect() {
    if (!creds) return;
    fetch("/api/stream-ticket?roomId=" + encodeURIComponent(creds.roomId), {
      method: "POST",
      headers: { Authorization: "Bearer " + creds.displayToken },
    }).then(function (res) {
      if (!res.ok) throw new Error("ticket");
      return res.json();
    }).then(function (data) {
      var es = new EventSource("/api/events?ticket=" + encodeURIComponent(data.ticket));
      es.addEventListener("state", function (e) {
        renderState(JSON.parse(e.data));
      });
      es.onerror = function () {
        es.close();
        // A ticket is single-use, so EventSource's built-in retry would reuse a
        // spent one. Reconnect through a fresh ticket instead. The server replays
        // current state on connect, so the QR reappears by itself.
        setTimeout(connect, 2000);
      };
    }).catch(function () {
      setTimeout(connect, 3000);
    });
  }

  if (creds) {
    show("idle");
    connect();
  } else show("pair");
})();
