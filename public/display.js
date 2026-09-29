// deno-lint-ignore-file no-var
// Deliberately ES5 (var, no arrow functions): this page runs on an old phone.
(function () {
  var LS = "swish-kassa-display";
  var creds = null;
  try {
    creds = JSON.parse(localStorage.getItem(LS) || "null");
  } catch (_e) { /* private mode or cleared storage */ }

  // Forget the pairing, so the pair screen can take a code for another room.
  // Used when the operator's room is lost (new phone, cleared browser data):
  // without it, stored creds would keep this display on "Välkommen" forever.
  function forgetPairing() {
    creds = null;
    try {
      localStorage.removeItem(LS);
    } catch (_e) { /* storage unavailable: nothing to clear */ }
  }

  // /display.html?pair is the explicit re-pair path. /display.html?code=123456
  // is what the operator's pairing QR opens: scanning it means "pair with this
  // room", so any old pairing is dropped and the code is claimed at once below.
  // Either way the query is removed, so a reload does not repeat it and the
  // single-use code does not linger in the address bar.
  var urlCode = (/[?&]code=(\d{6})(?:&|$)/.exec(location.search) || [])[1] || null;
  if (urlCode || /^\?pair(&|=|$)/.test(location.search)) {
    forgetPairing();
    try {
      history.replaceState(null, "", location.pathname);
    } catch (_e) { /* keep the query; harmless */ }
  }

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
      updateWakeHint();
      lock.addEventListener("release", function () {
        wakeLock = null;
        updateWakeHint();
      });
    }).catch(function () {
      updateWakeHint(); // denied, e.g. no user gesture yet: ask for one tap
    });
  }
  // Pairing by QR needs no tap on this page, and without a tap the browser may
  // refuse the wake lock, so the screen would go dark mid-market. Ask for one.
  function updateWakeHint() {
    el("wakeHint").hidden = !navigator.wakeLock || !!wakeLock;
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && !wakeLock) requestWakeLock();
  });
  document.addEventListener("click", function () {
    if (!wakeLock) requestWakeLock();
  });

  // --- screens -------------------------------------------------------------
  var THANKS_MS = 4000;
  var thanksTimer = null;

  function show(which) {
    clearTimeout(thanksTimer);
    el("pair").hidden = which !== "pair";
    el("idle").hidden = which !== "idle";
    el("thanks").hidden = which !== "thanks";
    el("charge").hidden = which !== "charge";
  }

  // After a paid charge the customer sees "Tack!" briefly, then the welcome
  // screen. A new charge arriving meanwhile replaces it at once (show clears
  // the timer).
  function showThanks() {
    show("thanks");
    thanksTimer = setTimeout(function () {
      show("idle");
    }, THANKS_MS);
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
      // `thanks` is only on the live event for a paid charge, never on a replay.
      if (data.thanks) showThanks();
      else show("idle");
    }
  }

  // --- pairing -------------------------------------------------------------
  // A real form, so the keyboard's Enter / Gå key submits the code too.
  el("pair").addEventListener("submit", function (e) {
    e.preventDefault();
    requestWakeLock(); // acquired here because this is a real user gesture
    claim(el("code").value.trim());
  });

  function claim(code) {
    el("pairError").textContent = "";
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
      show("pair");
      el("pairError").textContent = err.message === "429"
        ? "För många försök. Vänta en minut."
        : "Fel kod, eller så har den gått ut.";
    });
  }

  // --- live connection -----------------------------------------------------
  function setOnline(online) {
    el("status").hidden = online;
  }

  function connect() {
    if (!creds) {
      setOnline(true);
      return;
    }
    fetch("/api/stream-ticket?roomId=" + encodeURIComponent(creds.roomId), {
      method: "POST",
      headers: { Authorization: "Bearer " + creds.displayToken },
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        // The server no longer accepts this pairing (the room is gone):
        // retrying cannot help, so go back to the pair screen.
        forgetPairing();
        setOnline(true);
        show("pair");
        return null;
      }
      if (!res.ok) throw new Error("ticket");
      return res.json();
    }).then(function (data) {
      if (!data) return;
      var es = new EventSource("/api/events?ticket=" + encodeURIComponent(data.ticket));
      es.addEventListener("state", function (e) {
        setOnline(true);
        renderState(JSON.parse(e.data));
      });
      es.onerror = function () {
        setOnline(false);
        es.close();
        // A ticket is single-use, so EventSource's built-in retry would reuse a
        // spent one. Reconnect through a fresh ticket instead. The server replays
        // current state on connect, so the QR reappears by itself.
        setTimeout(connect, 2000);
      };
    }).catch(function () {
      setOnline(false);
      setTimeout(connect, 3000);
    });
  }

  if (urlCode) {
    el("code").value = urlCode; // visible if the claim fails, for a retry
    show("pair");
    requestWakeLock(); // may be refused without a tap; the hint covers that
    claim(urlCode);
  } else if (creds) {
    show("idle");
    connect();
    requestWakeLock();
  } else show("pair");
})();
