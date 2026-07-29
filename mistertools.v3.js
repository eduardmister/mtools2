/* ============================================================================
 * MisterTools 0.9.0 — mister.mundodeportivo.com
 * Herramienta informativa de SOLO LECTURA.
 * No puja, no compra, no vende, no clausula. No envía nada fuera del navegador.
 * ==========================================================================*/
(function () {
  "use strict";

  if (window.MisterTools && window.MisterTools.__running) {
    console.log("[MisterTools] Ya activo. Reescaneando.");
    window.MisterTools.rescan();
    return;
  }

  const CONFIG = {
    version: "0.9.0",
    maxBadgesCompact: 8,        // tope de badges antes de "+N"
    expandBadges: true,         // true = mostrar todos sin pulsar "+N"
    autoAnalyze: false,         // el análisis masivo no es viable (ver analysisEnabled)
    analysisEnabled: false,     // /ajax/sw/players exige X-Auth, inyectado por un
                                //   Service Worker fuera del alcance del bookmarklet.
    // URL del JSON de datos alojado por ti (se rellenará en el Bloque 2, GitHub
    // Pages). Vacía = sólo local. Debe apuntar a un dominio TUYO con HTTPS.
    dataUrl: "https://eduardmister.github.io/mtools2/datos.json",
    externalUrl: "https://eduardmister.github.io/mtools2/externo.json",
    githubRepo: "eduardmister/mtools2",   // owner/repo donde se sube datos.json
    githubBranch: "main",
    githubDataPath: "datos.json",
    autoLoadRemote: true,       // al arrancar, cargar dataUrl si está definida
    autoAnalyzeDelayMs: 2500,   // espera antes de arrancar el análisis
    historyDays: 90,            // snapshots por jugador en localStorage
    analysisDelayMs: 700,       // pausa entre peticiones al analizar el mercado
    analysisMaxPlayers: 40,     // tope por análisis
    analysisMaxErrors: 3,       // abortar si falla repetidamente
    debug: true,
    allowedHosts: ["mister.mundodeportivo.com"],
    maxDebtDivisor: 4,          // /ajax/community-check -> max_debt. 4 = 25%
    storagePrefix: "mistertools_"
  };

  // Endpoints de ESCRITURA: se ignoran por completo, nunca se invocan.
  const WRITE_ENDPOINTS = ["/ajax/bid", "/ajax/clause-set", "/ajax/sell",
    "/ajax/offer", "/ajax/market-set", "/ajax/shield"];

  const SENSITIVE = ["token", "authorization", "cookie", "password",
    "secret", "session", "jwt", "access", "refresh"];

  const L = (...a) => CONFIG.debug && console.log("[MisterTools]", ...a);
  const E = (...a) => console.error("[MisterTools]", ...a);

  if (CONFIG.allowedHosts.length && !CONFIG.allowedHosts.includes(location.hostname)) {
    console.warn("[MisterTools] Host no permitido:", location.hostname);
    return;
  }
  L("Inicializando versión " + CONFIG.version);

  /* --------------------------------------------------------------------
   * ESTADO
   * ------------------------------------------------------------------*/
  const state = {
    startedAt: Date.now(),
    me: { idUc: null, name: null, teamValue: null, players: null },
    balance: { current: null, future: null, maxDebt: null },
    community: { id: null, name: null, maxDebtDivisor: CONFIG.maxDebtDivisor },
    players: new Map(),      // id_player -> datos de API
    managers: new Map(),     // id_uc -> datos
    endpoints: [],
    seen: new Set(),
    logs: [],
    clauses: {},      // { eventId: {...} }
    external: {},     // FutbolFantasy indexado por nombre normalizado
    externalMeta: { total: 0, matched: 0, generatedAt: null },
    dataVersion: 0,   // se incrementa al llegar datos nuevos -> fuerza re-enriquecido
    via: { fetch: 0, xhr: 0, ajaxFetch: 0, ajaxXhr: 0 },  // diagnóstico
    observerActive: false,
    fetchOk: false,
    xhrOk: false,
    enriched: 0
  };

  const pushLog = (m) => {
    state.logs.unshift({ t: Date.now(), m });
    if (state.logs.length > 150) state.logs.pop();
  };

  /* --------------------------------------------------------------------
   * FORMATO
   * ------------------------------------------------------------------*/
  const nf = new Intl.NumberFormat("es-ES");

  function formatCurrency(v) {
    return v == null || isNaN(v) ? "—" : nf.format(Math.round(v)) + " €";
  }

  function formatCompactCurrency(v) {
    if (v == null || isNaN(v)) return "—";
    const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace(".", ",") + "M";
    if (a >= 1e3) return s + Math.round(a / 1e3) + "K";
    return s + Math.round(a);
  }

  function formatSignedCompact(v) {
    if (v == null || isNaN(v)) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + formatCompactCurrency(Math.abs(v));
  }

  function formatPercentage(v) {
    if (v == null || isNaN(v)) return "—";
    return (v > 0 ? "+" : "") + v.toFixed(1).replace(".", ",") + "%";
  }

  function formatTimeLeft(ts) {
    const diff = ts * 1000 - Date.now();
    if (diff <= 0) return "cerrado";
    const h = Math.floor(diff / 3.6e6), m = Math.floor((diff % 3.6e6) / 6e4);
    if (h >= 24) return Math.floor(h / 24) + "d " + (h % 24) + "h";
    if (h >= 1) return h + "h " + m + "m";
    return m + "m";
  }

  // "€ 8.802.000" -> 8802000
  // "16 jugadores · € 47.113.000" -> 47113000 (NO 16)
  function parseEuros(text) {
    if (!text) return null;
    const t = String(text).replace(/\s/g, "");
    // Prioridad 1: cifras con separador de millar (formato monetario de Mister)
    const dotted = t.match(/\d{1,3}(?:\.\d{3})+/g);
    if (dotted) {
      const best = dotted.sort((a, b) => b.length - a.length)[0];
      return parseInt(best.replace(/\./g, ""), 10);
    }
    // Prioridad 2: número inmediatamente después del símbolo de euro
    const eur = t.match(/€(\d+)/);
    if (eur) return parseInt(eur[1], 10);
    return null;
  }

  function normalizeName(n) {
    return !n ? "" : n.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, " ");
  }

  const POSITIONS = { 1: "PT", 2: "DF", 3: "MC", 4: "DL" };

  function formatDateShort(ts) {
    if (!ts) return "??";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + String(d.getFullYear()).slice(2);
  }

  function simpleHash(str) {
    let h = 0;
    const s2 = String(str);
    for (let i = 0; i < s2.length; i++) h = (h * 31 + s2.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  /* --------------------------------------------------------------------
   * CÁLCULO FINANCIERO
   * Verificado contra la API: maxDebt = future + teamValue / maxDebtDivisor
   * ------------------------------------------------------------------*/
  function calculateMaximumBid() {
    // Preferimos el dato real servido por /ajax/balance
    if (state.balance.maxDebt != null) {
      return { value: state.balance.maxDebt, estimated: false };
    }
    // Fallback calculado
    if (state.balance.future != null && state.me.teamValue != null) {
      const v = state.balance.future + state.me.teamValue / state.community.maxDebtDivisor;
      return { value: v, estimated: true };
    }
    return { value: null, estimated: true };
  }

  function calculateMissingAmount(price, maximumBid) {
    return Math.max(0, price - maximumBid);
  }

  // Vender 1 € sube el saldo 1 € pero baja el valor de equipo 1 €,
  // así que la capacidad neta sube (1 - 1/divisor) €.
  function calculateRequiredSales(missing, divisor) {
    const perEuro = 1 - 1 / divisor;
    return perEuro <= 0 ? Infinity : Math.ceil(missing / perEuro);
  }

  // Días para amortizar el sobrecoste de la cláusula si el jugador sigue
  // subiendo a su ritmo reciente. sobrecoste = cláusula - valor de mercado.
  function clauseBreakeven(player, currentValue) {
    const cv = clauseValue(player);
    if (cv == null || currentValue == null) return null;
    const sobrecoste = cv - currentValue;
    if (sobrecoste <= 0) return { dias: 0, sobrecoste: 0 };  // ya sale a cuenta

    // Ritmo diario: preferimos la media de 7 días de la serie; si no, el delta 1 día.
    let ritmo = null;
    const series = extractMarketHistory(player.id);
    if (series && series.length >= 8) {
      const d7 = calculateChangeOverDays(series, 7);
      if (d7) ritmo = d7.change / 7;
    }
    if (ritmo == null && player.values) {
      const day = player.values.find((v) => v.time === "Un día");
      if (day && day.change != null) ritmo = day.change;
    }
    if (ritmo == null || ritmo <= 0) return { dias: Infinity, sobrecoste };
    return { dias: Math.ceil(sobrecoste / ritmo), sobrecoste, ritmo };
  }

  function clauseValue(player) {
    if (!player || !player.clause) return null;
    const c = player.clause;
    if (c.value != null) return c.value;
    if (c.floor != null && c.multiplier != null) return c.floor * c.multiplier;
    return null;
  }


  /* --------------------------------------------------------------------
   * HISTÓRICO LOCAL DE VALORES
   * El listado del mercado sólo expone el valor actual: para conocer la
   * subida diaria de un jugador que no hemos abierto guardamos un snapshot
   * por día. A partir del segundo día el dato es real, no estimado.
   * ------------------------------------------------------------------*/
  const HKEY = CONFIG.storagePrefix + "history";
  let history = {};

  function loadHistory() {
    try { history = JSON.parse(localStorage.getItem(HKEY) || "{}"); }
    catch (e) { history = {}; }
  }

  let saveTimer = null;
  function saveHistory() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(HKEY, JSON.stringify(history)); }
      catch (e) { E("No se pudo guardar el histórico:", e); }
    }, 1500);
  }

  const today = () => new Date().toISOString().slice(0, 10);

  function recordSnapshot(id, name, value) {
    if (!id || value == null) return;
    const e = history[id] || (history[id] = { n: name, s: [] });
    if (name) e.n = name;
    const d = today();
    const last = e.s[e.s.length - 1];
    if (last && last[0] === d) { last[1] = value; }
    else {
      e.s.push([d, value]);
      if (e.s.length > CONFIG.historyDays) e.s = e.s.slice(-CONFIG.historyDays);
    }
    saveHistory();
  }

  // Devuelve el snapshot más reciente anterior a hoy, con los días transcurridos.
  function previousSnapshot(id) {
    const e = history[id];
    if (!e || e.s.length < 2) return null;
    const d = today();
    for (let i = e.s.length - 1; i >= 0; i--) {
      if (e.s[i][0] !== d) {
        const days = Math.round((Date.parse(d) - Date.parse(e.s[i][0])) / 864e5);
        return { value: e.s[i][1], days: days };
      }
    }
    return null;
  }

  /* --------------------------------------------------------------------
   * MÉTRICAS DERIVADAS
   * ------------------------------------------------------------------*/

  // Variación diaria. Prioridad: dato oficial de la API > histórico propio.
  function calculateMarketTrend(id, currentValue) {
    const api = state.players.get(id) || {};

    if (api.values && api.values.length) {
      const d = api.values.find((v) => v.time === "Un día");
      if (d && d.change != null && d.value != null) {
        return { change: d.change, base: d.value, days: 1, source: "api" };
      }
    }
    if (api.previousValue != null && currentValue != null) {
      return { change: currentValue - api.previousValue, base: api.previousValue,
               days: 1, source: "api" };
    }
    const prev = previousSnapshot(id);
    if (prev && currentValue != null) {
      return { change: currentValue - prev.value, base: prev.value,
               days: prev.days, source: "local" };
    }
    return null;
  }

  // Serie diaria completa (sólo disponible si se ha abierto la ficha).
  function extractMarketHistory(id) {
    const api = state.players.get(id) || {};
    const chart = api.valuesChart && api.valuesChart.points;
    if (chart && chart.length >= 2) {
      return chart.map((p) => p.value);
    }
    const e = history[id];
    if (e && e.s.length >= 2) return e.s.map((x) => x[1]);
    return null;
  }

  // Días consecutivos subiendo (positivo) o bajando (negativo).
  function calculateStreakDays(series) {
    if (!series || series.length < 2) return 0;
    let dir = 0, count = 0;
    for (let i = series.length - 1; i > 0; i--) {
      const diff = series[i] - series[i - 1];
      const s = diff > 0 ? 1 : diff < 0 ? -1 : 0;
      if (s === 0) break;
      if (dir === 0) dir = s;
      else if (s !== dir) break;
      count++;
    }
    return dir * count;
  }

  // Acelerando si la última subida supera con claridad la media de las previas.
  function calculateAcceleration(series) {
    if (!series || series.length < 4) return null;
    const deltas = [];
    for (let i = 1; i < series.length; i++) deltas.push(series[i] - series[i - 1]);
    const last = deltas[deltas.length - 1];
    const prev = deltas.slice(-4, -1);
    const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
    if (avg === 0) return null;
    const ratio = last / avg;
    if (last > 0 && ratio >= 1.5) return "acelerando";
    if (last > 0 && ratio <= 0.5) return "frenando";
    return null;
  }

  // Variación acumulada en N días.
  function calculateChangeOverDays(series, n) {
    if (!series || series.length < n + 1) return null;
    const a = series[series.length - 1 - n], b = series[series.length - 1];
    if (a == null || b == null || a === 0) return null;
    return { change: b - a, pct: ((b - a) / a) * 100, days: n };
  }

  // Posición del valor actual dentro de su rango anual.
  // La API expone max/min del periodo; si no, se derivan de la serie.
  function calculateValuePosition(id, current) {
    const api = state.players.get(id) || {};
    const vc = api.valuesChart;
    let max = vc && vc.max ? vc.max.value : null;
    let min = vc && vc.min ? vc.min.value : null;
    const maxDate = vc && vc.max ? vc.max.date : null;
    const series = extractMarketHistory(id);
    if ((max == null || min == null) && series && series.length > 5) {
      max = Math.max.apply(null, series);
      min = Math.min.apply(null, series);
    }
    if (max == null || min == null || current == null || max === min) return null;
    return {
      max: max, min: min, maxDate: maxDate,
      fromMax: ((current - max) / max) * 100,
      pctRange: ((current - min) / (max - min)) * 100,
      samples: series ? series.length : null
    };
  }

  // Volatilidad del valor: desviación relativa de las variaciones diarias.
  function calculateValueVolatility(series) {
    if (!series || series.length < 10) return null;
    const d = [];
    for (let i = 1; i < series.length; i++) {
      if (series[i - 1]) d.push((series[i] - series[i - 1]) / series[i - 1]);
    }
    if (d.length < 5) return null;
    const m = d.reduce((a, b) => a + b, 0) / d.length;
    const v = d.reduce((a, b) => a + (b - m) * (b - m), 0) / d.length;
    return Math.sqrt(v) * 100;
  }

  /* --------------------------------------------------------------------
   * INTERCEPTACIÓN PASIVA
   * ------------------------------------------------------------------*/
  function isSensitive(k) {
    const l = String(k).toLowerCase();
    return SENSITIVE.some((p) => l.includes(p));
  }

  function sanitize(d, depth) {
    depth = depth || 0;
    if (d == null || depth > 5) return typeof d === "object" ? "[...]" : d;
    if (Array.isArray(d)) return d.slice(0, 5).map((x) => sanitize(x, depth + 1));
    if (typeof d === "object") {
      const o = {}; let i = 0;
      for (const k in d) {
        if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
        if (i++ >= 25) { o["..."] = "(truncado)"; break; }
        o[k] = isSensitive(k) ? "***oculto***" : sanitize(d[k], depth + 1);
      }
      return o;
    }
    return d;
  }

  function ingestPlayer(p) {
    if (!p || p.id == null || !p.name) return;
    const id = String(p.id);
    const prev = state.players.get(id) || {};
    state.players.set(id, Object.assign(prev, {
      id: id,
      name: p.name,
      position: p.position,
      value: p.value != null ? p.value : prev.value,
      previousValue: p.previousValue != null ? p.previousValue : prev.previousValue,
      points: p.points != null ? p.points : prev.points,
      avg: p.avg != null ? p.avg : prev.avg,
      clause: p.clause || prev.clause,
      market: p.market || prev.market,
      owner: p.owner || prev.owner,
      pointsHistory: p.points_history || prev.pointsHistory,
      values: p.values || prev.values,
      valuesChart: p.values_chart || prev.valuesChart,
      nextMatch: p.next_match || prev.nextMatch,
      injury: p.injury || prev.injury,
      clausesRanking: p.clausesRanking != null ? p.clausesRanking : prev.clausesRanking,
      starter: p.starter != null ? p.starter : prev.starter,
      gameweeks: p.gameweeks || prev.gameweeks
    }));
  }

  function processResponse(url, method, status, data) {
    try {
      const path = (() => { try { return new URL(url, location.href).pathname; } catch (e) { return url; } })();

      // Nunca procesamos endpoints de escritura, salvo para leer el saldo
      // resultante (que la propia app ya ha recibido).
      const isWrite = WRITE_ENDPOINTS.some((w) => path.indexOf(w) === 0);

      const d = data && data.data;
      if (!d) return;

      // --- Saldo -------------------------------------------------------
      const bal = d.balance || (d.current != null && d.maxDebt != null ? d : null);
      if (bal && bal.maxDebt != null) {
        state.balance = {
          current: bal.current != null ? bal.current : state.balance.current,
          future: bal.future != null ? bal.future : state.balance.future,
          maxDebt: bal.maxDebt
        };
        pushLog("Saldo actualizado: puja máx " + formatCurrency(bal.maxDebt));
      }

      // --- Comunidad ---------------------------------------------------
      if (d.communities) {
        for (const k in d.communities) {
          const c = d.communities[k];
          if (c.mode === "private" || !state.community.id) {
            state.community = {
              id: c.id, name: c.name,
              maxDebtDivisor: c.max_debt || CONFIG.maxDebtDivisor
            };
            if (c.id_uc) state.me.idUc = String(c.id_uc);
            if (c.balance != null && state.balance.current == null) {
              state.balance.current = c.balance;
            }
          }
        }
      }

      // --- Plantilla de un mánager (/ajax/sw/users) ---------------------
      if (d.team_now && Array.isArray(d.team_now)) {
        d.team_now.forEach(ingestPlayer);
        if (state.me.idUc && String(d.id) === state.me.idUc && d.value) {
          state.me.teamValue = d.value.value;
          state.me.players = d.team_now.length;
          pushLog("Valor de equipo propio: " + formatCurrency(d.value.value));
        }
        if (d.userInfo) {
          state.managers.set(String(d.id), {
            id: String(d.id), name: d.userInfo.name,
            teamValue: d.value ? d.value.value : null
          });
        }
      }

      // --- Ficha de jugador --------------------------------------------
      if (d.player) {
        const p = Object.assign({}, d.player);
        p.points_history = d.points_history;
        p.values = d.values;
        p.values_chart = d.values_chart;
        p.next_match = d.next_match && d.next_match[String(d.player.id)];
        p.gameweeks = d.points;
        p.starter = d.starter;
        ingestPlayer(p);
      }
      // /ajax/player-community-info devuelve el jugador en la raíz
      if (!d.player && d.id != null && d.name && d.clause) ingestPlayer(d);

      // --- Registro para la pestaña de API ------------------------------
      const key = method + path + status + JSON.stringify(Object.keys(d)).length;
      if (!state.seen.has(key)) {
        state.seen.add(key);
        state.endpoints.unshift({
          url: path, method, status, time: Date.now(),
          write: isWrite,
          fields: Object.keys(d).filter((k) => !isSensitive(k)).slice(0, 40),
          sample: sanitize(data)
        });
        if (state.endpoints.length > 100) state.endpoints.pop();
      }

      // Las filas ya pintadas deben repintarse con los datos nuevos:
      // el DOM del mercado se renderiza antes de que lleguen saldo y fichas.
      state.dataVersion++;
      scheduleScan();
    } catch (e) {
      E("Error procesando respuesta:", e);
    }
  }

  // Cuerpos de petición observados, saneados. Sirven para conocer el formato
  // que espera cada endpoint. Nunca se envían a ningún sitio.
  state.requestBodies = {};

  // Cabeceras que la propia web envía a /ajax/*. Se guardan SÓLO en memoria,
  // nunca en localStorage, nunca se muestran ni se exportan. Sirven para que
  // el análisis reproduzca la petición tal cual la hace Mister: si su API
  // exige un token o cabecera propia, se reenvía sin que llegue a leerse.
  let replayHeaders = null;

  function recordRequestHeaders(url, headers) {
    try {
      if (!headers) return;
      if (String(url).indexOf("/ajax/") === -1) return;
      // Se acumulan de TODAS las peticiones, no sólo de la primera: distintos
      // endpoints envían cabeceras distintas y alguna (p. ej. la de auth)
      // puede no aparecer en la primera que observemos.
      const out = {};
      const put = (k, v) => {
        const lk = String(k).toLowerCase();
        // Las que gestiona el navegador no se pueden reenviar a mano.
        if (["cookie", "host", "content-length", "origin", "referer",
             "user-agent", "connection"].indexOf(lk) !== -1) return;
        out[k] = v;
      };
      if (typeof Headers !== "undefined" && headers instanceof Headers) {
        headers.forEach((v, k) => put(k, v));
      } else if (Array.isArray(headers)) {
        headers.forEach((pair) => put(pair[0], pair[1]));
      } else if (typeof headers === "object") {
        for (const k in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, k)) put(k, headers[k]);
        }
      }
      const keys = Object.keys(out);
      if (!keys.length) return;
      const before = replayHeaders ? Object.keys(replayHeaders).length : 0;
      replayHeaders = Object.assign({}, replayHeaders || {}, out);
      const after = Object.keys(replayHeaders).length;
      if (after > before) {
        L("Cabeceras de la app observadas:", Object.keys(replayHeaders).join(", "));
      }
    } catch (e) {}
  }

  function recordRequestBody(url, method, body) {
    try {
      if (body == null) return;
      const path = (() => { try { return new URL(url, location.href).pathname; } catch (e) { return url; } })();
      let parsed = body;
      if (typeof body === "string") {
        try { parsed = JSON.parse(body); }
        catch (e) {
          if (body.indexOf("=") !== -1) {
            parsed = {};
            new URLSearchParams(body).forEach((v, k) => { parsed[k] = v; });
          }
        }
      } else if (typeof FormData !== "undefined" && body instanceof FormData) {
        parsed = {}; body.forEach((v, k) => { parsed[k] = v; });
      }
      state.requestBodies[path] = {
        method: method,
        contentType: typeof body === "string" ? "texto" : "objeto",
        body: sanitize(parsed)
      };
    } catch (e) {}
  }

  const _fetch = window.fetch;
  function hookFetch() {
    if (!_fetch) return;
    window.fetch = function (...args) {
      try {
        const u0 = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        const o = args[1] || {};
        recordRequestBody(u0, o.method || "GET", o.body);
        if (o.headers) recordRequestHeaders(u0, o.headers);
        // fetch(new Request(url, {headers})) — las cabeceras van en el Request
        if (args[0] && typeof args[0] === "object" && args[0].headers) {
          recordRequestHeaders(u0, args[0].headers);
        }
      } catch (e) {}
      try {
        const uu = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        state.via.fetch++;
        if (String(uu).indexOf("/ajax/") !== -1) state.via.ajaxFetch++;
      } catch (e) {}
      const p = _fetch.apply(this, args);
      p.then((res) => {
        try {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            res.clone().json().then((d) => {
              const u = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
              const m = (args[1] && args[1].method) || "GET";
              processResponse(u, m, res.status, d);
            }).catch(() => {});
          }
        } catch (e) {}
      }).catch(() => {});
      return p;
    };
    state.fetchOk = true;
    L("Fetch interceptado");
  }

  /* Interceptación de XHR mediante el PROTOTIPO.
   * Parchear window.XMLHttpRequest no basta: si la web guardó una referencia
   * al constructor original antes de ejecutarse el bookmarklet, sus peticiones
   * lo esquivan por completo. Parcheando el prototipo se alcanzan todas las
   * instancias, incluidas las creadas desde referencias previas. */
  const _XHR = window.XMLHttpRequest;
  const XP = _XHR && _XHR.prototype;
  const _open = XP && XP.open;
  const _send = XP && XP.send;
  const _srh = XP && XP.setRequestHeader;

  function hookXhr() {
    if (!XP) { warn("XMLHttpRequest no disponible."); return; }

    XP.open = function (method, url) {
      try { this.__mt = { m: method, u: url, h: {} }; } catch (e) {}
      return _open.apply(this, arguments);
    };

    XP.setRequestHeader = function (k, v) {
      try { if (this.__mt) this.__mt.h[k] = v; } catch (e) {}
      return _srh.apply(this, arguments);
    };

    XP.send = function (body) {
      try {
        const ctx = this.__mt;
        if (ctx) {
          state.via.xhr++;
          if (String(ctx.u).indexOf("/ajax/") !== -1) state.via.ajaxXhr++;
          recordRequestBody(ctx.u, ctx.m, body);
          recordRequestHeaders(ctx.u, ctx.h);
          this.addEventListener("load", function () {
            try {
              const ct = this.getResponseHeader("content-type") || "";
              if (ct.indexOf("application/json") !== -1) {
                processResponse(ctx.u, ctx.m, this.status, JSON.parse(this.responseText));
              }
            } catch (e) { /* respuesta no JSON: se ignora */ }
          });
        }
      } catch (e) {}
      return _send.apply(this, arguments);
    };

    state.xhrOk = true;
    L("XHR interceptado (prototipo)");
  }

  /* --------------------------------------------------------------------
   * SELECTORES REALES (verificados sobre el DOM de Mister)
   * ------------------------------------------------------------------*/
  const SELECTORS = {
    marketRow: "li[data-price]",
    playerRow: ".player-row",
    playerLink: "a.btn-sw-link.player",
    playerAvatar: ".player-avatar[data-id_player]",
    playerName: ".info .name",
    playerValue: ".info .underName",
    playerPoints: ".icons .points",
    playerPosition: ".player-position[data-position]",
    playerAvg: ".streak-wrapper .avg",
    userLink: "a.btn-sw-link.user",
    userName: ".info .name",
    userPlayed: ".info .played",
    userPosition: ".position",
    userPoints: ".points",
    myself: ".name.myself"
  };

  /* --------------------------------------------------------------------
   * BADGES
   * ------------------------------------------------------------------*/
  function createBadge(text, type, tooltip) {
    const b = document.createElement("span");
    b.className = "mistertools-badge mistertools-badge--" + (type || "info");
    b.textContent = text;
    if (tooltip) b.title = tooltip;
    return b;
  }

  function badgeRow(container) {
    let r = container.querySelector(":scope > .mistertools-badge-row");
    if (!r) {
      r = document.createElement("div");
      r.className = "mistertools-badge-row";
      container.appendChild(r);
    } else {
      r.textContent = "";   // repintado limpio, sin duplicar badges
    }
    return r;
  }

  // Devuelve true si la fila ya está pintada con la versión de datos actual.
  function alreadyFresh(row) {
    return row.getAttribute("data-mistertools-enriched") === "true" &&
      row.getAttribute("data-mistertools-v") === String(state.dataVersion);
  }

  function markFresh(row) {
    row.setAttribute("data-mistertools-enriched", "true");
    row.setAttribute("data-mistertools-v", String(state.dataVersion));
  }

  /* --------------------------------------------------------------------
   * ENRIQUECIMIENTO
   * ------------------------------------------------------------------*/
  function readPlayerRow(row) {
    const avatar = row.querySelector(SELECTORS.playerAvatar);
    const id = avatar ? avatar.getAttribute("data-id_player") : null;
    if (!id) return null;

    const nameEl = row.querySelector(SELECTORS.playerName);
    const valueEl = row.querySelector(SELECTORS.playerValue);
    const posEl = row.querySelector(SELECTORS.playerPosition);

    return {
      id: String(id),
      domName: nameEl ? nameEl.textContent.trim() : null,
      domValue: valueEl ? parseEuros(valueEl.textContent) : null,
      position: posEl ? parseInt(posEl.getAttribute("data-position"), 10) : null,
      trend: valueEl && valueEl.querySelector(".value-arrow.green") ? "up"
        : valueEl && valueEl.querySelector(".value-arrow.red") ? "down" : null
    };
  }

  /* --------------------------------------------------------------------
   * PRIORIDAD DE BADGES
   * Cuanto mayor el peso, antes se muestra. Los riesgos van siempre arriba.
   * ------------------------------------------------------------------*/
  const P = { risk: 100, starter: 90, market: 80, form: 60, value: 50,
              fixture: 40, consistency: 30, clause: 25, squad: 20, info: 10 };

  function selectPriorityBadges(list, max) {
    // Orden estable: primero por prioridad; ante empate, por el texto, para
    // que un mismo badge aparezca SIEMPRE en la misma posición y no baile.
    const ok = list.filter(Boolean).sort((a, b) => {
      if (b.p !== a.p) return b.p - a.p;
      return String(a.text).localeCompare(String(b.text));
    });
    return { shown: ok.slice(0, max), hidden: ok.slice(max) };
  }

  function enrichPlayerCard(row, ctx) {
    if (alreadyFresh(row)) return;

    const dom = readPlayerRow(row);
    if (!dom) return;

    const api = state.players.get(dom.id) || {};
    const value = dom.domValue != null ? dom.domValue : api.value;
    const name = api.name || dom.domName;

    recordSnapshot(dom.id, name, value);

    const badges = [];

    /* --- 1. Variación de mercado (el badge principal) ---------------- */
    const trend = calculateMarketTrend(dom.id, value);
    if (trend && trend.base) {
      const pct = (trend.change / trend.base) * 100;
      const suffix = trend.days > 1 ? " · " + trend.days + "d" : "";
      badges.push({
        p: P.market + Math.min(Math.abs(pct), 20),   // subidas fuertes suben en la lista
        text: "💶 " + (trend.change >= 0 ? "↑" : "↓") + formatSignedCompact(trend.change) +
              " · " + formatPercentage(pct) + suffix,
        type: trend.change > 0 ? "success" : trend.change < 0 ? "danger" : "neutral",
        tip: (trend.days > 1
              ? "Variación en " + trend.days + " días: "
              : "Variación en 24 h: ") +
             formatCurrency(trend.base) + " → " + formatCurrency(value) +
             (trend.source === "local" ? " (histórico local de MisterTools)" : " (dato de Mister)")
      });
    }

    /* --- Serie diaria: racha y aceleración --------------------------- */
    const series = extractMarketHistory(dom.id);
    if (series) {
      const streak = calculateStreakDays(series);
      if (Math.abs(streak) >= 3) {
        badges.push({
          p: P.market - 5,
          text: (streak > 0 ? "🔥 " : "🧊 ") + Math.abs(streak),
          type: streak > 0 ? "success" : "danger",
          tip: Math.abs(streak) + " días consecutivos " + (streak > 0 ? "subiendo" : "bajando")
        });
      }
      const acc = calculateAcceleration(series);
      if (acc) {
        badges.push({
          p: P.market - 8,
          text: acc === "acelerando" ? "📈 Acelerando" : "📉 Frenando",
          type: acc === "acelerando" ? "success" : "warning",
          tip: "La última variación " +
               (acc === "acelerando" ? "supera" : "queda por debajo de") +
               " la media de los días anteriores"
        });
      }
      [3, 7, 30].forEach((n) => {
        const c = calculateChangeOverDays(series, n);
        if (!c) return;
        badges.push({
          p: P.market - 10 - n / 10,
          text: "📅 " + (c.change >= 0 ? "↑" : "↓") + formatPercentage(c.pct) + " · " + n + "d",
          type: c.change >= 0 ? "success" : "danger",
          tip: "Acumulado " + n + " días: " + formatSignedCompact(c.change)
        });
      });
    }

    /* --- Contexto histórico: distancia a su máximo anual --------------- */
    const pos = calculateValuePosition(dom.id, value);
    if (pos && pos.samples && pos.samples >= 30) {
      if (pos.fromMax <= -20) {
        badges.push({
          p: P.value + 8,
          text: "🛒 " + formatPercentage(pos.fromMax) + " de su techo",
          type: "success",
          tip: "Máximo del periodo: " + formatCurrency(pos.max) +
               (pos.maxDate ? " (" + pos.maxDate + ")" : "") +
               ". Mínimo: " + formatCurrency(pos.min) +
               ". Está en el " + pos.pctRange.toFixed(0) + " % de su rango anual."
        });
      } else if (pos.pctRange >= 92) {
        badges.push({
          p: P.value + 6,
          text: "⛰ En máximos",
          type: "warning",
          tip: "Cerca de su techo anual (" + formatCurrency(pos.max) + "). " +
               "Riesgo de corrección a la baja."
        });
      }
    }

    /* --- Titularidad (FutbolFantasy) ---------------------------------- */
    externalBadgesFor(name).forEach((b) => badges.push(b));

    /* --- 2. Riesgo deportivo ----------------------------------------- */
    if (api.injury && api.injury.length) {
      badges.push({ p: P.risk, text: "🚑 Lesionado", type: "danger",
        tip: "Mister marca a este jugador como lesionado" });
    }

    /* --- 3. Rendimiento histórico ------------------------------------ */
    if (api.pointsHistory && api.pointsHistory.length) {
      const last = api.pointsHistory[0];
      badges.push({
        p: P.info,
        text: "⭐ " + last.points + " pts · " + Number(last.avg).toFixed(1).replace(".", ",") + " media",
        type: "neutral", tip: "Temporada " + last.season
      });

      // (Badge pts/M€ oculto por preferencia del usuario)
    }

    /* --- 4. Cláusula -------------------------------------------------- */
    const cv = clauseValue(api);
    if (cv != null) {
      badges.push({ p: P.clause, text: "🔒 " + formatCompactCurrency(cv),
        type: "neutral", tip: formatCurrency(cv) });
    }

    /* --- Amortización de la cláusula --------------------------------- */
    const be = clauseBreakeven(api, value);
    if (be) {
      if (be.dias === 0) {
        badges.push({ p: P.value + 3, text: "💰 Ya amortiza", type: "success",
          tip: "La cláusula está por debajo de su valor de mercado actual." });
      } else if (be.dias !== Infinity && be.dias <= 180) {
        const tipo = be.dias <= 30 ? "success" : be.dias <= 60 ? "warning" : "neutral";
        badges.push({
          p: P.value + 3,
          text: "⏳ " + be.dias + "d amortiza",
          type: tipo,
          tip: "Si sigue subiendo a su ritmo reciente (~" +
               formatCompactCurrency(be.ritmo) + "/día), recuperarías el sobrecoste de " +
               formatCurrency(be.sobrecoste) + " de la cláusula en unos " + be.dias + " días."
        });
      }
    }

    /* --- Ranking de robos por cláusula: icono + "Top N", tras titularidad -- */
    if (api.clausesRanking != null) {
      const r = api.clausesRanking;
      badges.push({
        p: 89,   // justo por debajo del 90 de titularidad -> queda a continuación
        text: "💥 Top " + r,
        type: r <= 50 ? "danger" : r <= 100 ? "warning" : "neutral",
        tip: "Puesto " + r + " en el ranking de más robados por cláusula. " +
             "Cuanto más bajo, más expuesto está."
      });
    }

    // (Badge de próximo rival oculto: Mister ya lo muestra de forma nativa)

    /* --- 6. Contexto de mercado --------------------------------------- */
    if (ctx && ctx.price != null) {
      // Diferencia precio/valor: SÓLO tiene sentido en agentes libres.
      // Si el jugador tiene dueño, el precio se fijó al publicarlo y no se
      // actualiza aunque suba el valor, así que un precio inferior no indica
      // ninguna oportunidad real.
      const isFree = !ctx.owner || ctx.owner === "0";
      if (isFree && value != null) {
        const gap = value - ctx.price;
        const pct = (gap / value) * 100;
        if (Math.abs(pct) >= 0.5) {
          badges.push({
            p: P.value + 5,
            text: (gap > 0 ? "🏷️ " : "⚠️ ") + formatPercentage(-pct),
            type: gap > 0 ? "success" : "danger",
            tip: "Agente libre: piden " + formatCurrency(ctx.price) +
                 " y vale " + formatCurrency(value)
          });
        }
      }

      if (ctx.ends) {
        const urgent = ctx.ends * 1000 - Date.now() < 3.6e6;
        badges.push({
          p: urgent ? P.risk - 5 : P.info + 5,
          text: "⏱ " + formatTimeLeft(ctx.ends),
          type: urgent ? "warning" : "neutral",
          tip: "Finaliza " + new Date(ctx.ends * 1000).toLocaleString("es-ES")
        });
      }

      const max = calculateMaximumBid();
      if (max.value != null) {
        const missing = calculateMissingAmount(ctx.price, max.value);
        const pctBudget = (ctx.price / max.value) * 100;
        badges.push({
          p: P.squad + 40,
          text: missing <= 0
            ? "✅ Puedes pujar · " + pctBudget.toFixed(0) + "%"
            : "🔐 Faltan " + formatCompactCurrency(missing),
          type: missing <= 0 ? "success" : "danger",
          tip: missing <= 0
            ? "Consume el " + pctBudget.toFixed(0) + " % de tu tope (" +
              formatCurrency(max.value) + "). Pulsa para el desglose."
            : "Pulsa para ver cuánto tendrías que vender",
          click: () => showBidPopup(dom, api, ctx, max),
          estimated: max.estimated
        });
      }
    }

    /* --- Render con prioridad y expansión ------------------------------ */
    const info = row.querySelector(".info") || row;
    const bar = badgeRow(info);
    const sel = selectPriorityBadges(badges,
      CONFIG.expandBadges ? badges.length : CONFIG.maxBadgesCompact);
    if (!sel.shown.length) { bar.remove(); return; }

    const paint = (b) => {
      const el = createBadge(b.text, b.type, b.tip);
      if (b.click) {
        el.classList.add("mistertools-badge--clickable");
        el.addEventListener("click", (ev) => {
          ev.preventDefault(); ev.stopPropagation(); b.click();
        });
      }
      if (b.estimated) el.classList.add("mistertools-badge--est");
      bar.appendChild(el);
    };

    sel.shown.forEach(paint);

    if (sel.hidden.length) {
      const more = createBadge("+" + sel.hidden.length, "neutral", "Ver el resto de indicadores");
      more.classList.add("mistertools-badge--clickable");
      more.addEventListener("click", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        more.remove();
        sel.hidden.forEach(paint);
      });
      bar.appendChild(more);
    }

    markFresh(row);
  }


  function enrichManagerCard(row) {
    if (alreadyFresh(row)) return;
    const link = row.querySelector(SELECTORS.userLink);
    if (!link) return;

    const href = link.getAttribute("href") || "";
    const m = href.match(/users\/(\d+)/);
    const idUc = m ? m[1] : null;
    const nameEl = row.querySelector(SELECTORS.userName);
    const playedEl = row.querySelector(SELECTORS.userPlayed);
    const isMe = !!row.querySelector(SELECTORS.myself);

    const teamValue = playedEl ? parseEuros(playedEl.textContent) : null;

    if (isMe && idUc) {
      state.me.idUc = idUc;
      state.me.name = nameEl ? nameEl.textContent.trim() : null;
      if (teamValue != null) state.me.teamValue = teamValue;
    }
    if (idUc) {
      state.managers.set(idUc, {
        id: idUc,
        name: nameEl ? nameEl.textContent.trim() : null,
        teamValue, isMe
      });
    }

    const info = row.querySelector(".info") || row;
    const bar = badgeRow(info);
    let added = 0;

    if (teamValue != null) {
      // Capacidad de puja teórica de ese mánager (su saldo no es público,
      // así que solo mostramos el componente derivado del valor de equipo).
      bar.appendChild(createBadge(
        "🏦 " + formatCompactCurrency(teamValue / state.community.maxDebtDivisor),
        "neutral",
        "El " + (100 / state.community.maxDebtDivisor).toFixed(0) +
        " % de su valor de equipo. No incluye su saldo, que no es público."));
      added++;
    }

    if (isMe) {
      const max = calculateMaximumBid();
      if (max.value != null) {
        bar.appendChild(createBadge("💰 Tu puja máx " + formatCompactCurrency(max.value),
          "success", formatCurrency(max.value)));
        added++;
      }
    }

    if (added > 0) {
      markFresh(row);
    } else {
      bar.remove();
    }
  }

  /* --------------------------------------------------------------------
   * POPUP DE PUJA
   * ------------------------------------------------------------------*/
  function showBidPopup(dom, api, ctx, max) {
    const missing = calculateMissingAmount(ctx.price, max.value);
    const sales = calculateRequiredSales(missing, state.community.maxDebtDivisor);
    const pct = (100 / state.community.maxDebtDivisor).toFixed(0);
    const perEuro = (1 - 1 / state.community.maxDebtDivisor).toFixed(2).replace(".", ",");

    const ov = document.createElement("div");
    ov.className = "mistertools-overlay";
    const box = document.createElement("div");
    box.className = "mistertools-modal";

    const rows = [
      ["PRECIO MÍNIMO", formatCurrency(ctx.price)],
      ["TU PUJA MÁXIMA", formatCurrency(max.value) + (max.estimated ? " (estimado)" : "")],
      ["TE FALTAN", formatCurrency(missing)],
      ["TENDRÍAS QUE VENDER", sales === Infinity ? "—" : formatCurrency(sales) + " (estimado)"]
    ];

    const h = document.createElement("h3");
    h.textContent = (api.name || dom.domName || "Jugador");
    box.appendChild(h);

    rows.forEach(([k, v]) => {
      const r = document.createElement("div");
      r.className = "mistertools-modal-row";
      const a = document.createElement("span"); a.textContent = k;
      const b = document.createElement("strong"); b.textContent = v;
      r.append(a, b);
      box.appendChild(r);
    });

    const note = document.createElement("p");
    note.className = "mistertools-note";
    note.textContent = "Con una puja máxima basada en saldo más el " + pct +
      " % del valor del equipo, cada euro vendido incrementa la capacidad de puja " +
      "en aproximadamente " + perEuro + " €. La venta necesaria es una estimación.";
    box.appendChild(note);

    const close = document.createElement("button");
    close.className = "mistertools-btn";
    close.textContent = "Cerrar";
    close.addEventListener("click", () => ov.remove());
    box.appendChild(close);

    ov.appendChild(box);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }

  /* --------------------------------------------------------------------
   * ESCANEO
   * ------------------------------------------------------------------*/
  function scan() {
    try {
      // 1) Filas de mercado (li[data-price] -> contexto de subasta)
      document.querySelectorAll(SELECTORS.marketRow).forEach((li) => {
        const row = li.querySelector(SELECTORS.playerRow);
        if (!row) return;
        enrichPlayerCard(row, {
          price: parseInt(li.getAttribute("data-price"), 10) || null,
          owner: li.getAttribute("data-owner") || null,
          ends: parseInt(li.getAttribute("data-ends"), 10) || null
        });
      });

      // 2) Filas de jugador sin contexto de mercado (plantilla)
      document.querySelectorAll(SELECTORS.playerRow).forEach((row) => {
        if (row.closest(SELECTORS.marketRow)) return;   // ya tratada arriba
        if (row.querySelector(SELECTORS.userLink)) {     // es un mánager
          enrichManagerCard(row);
          return;
        }
        if (row.querySelector(SELECTORS.playerLink)) enrichPlayerCard(row, null);
      });

      scanClauses();
      enrichManagerProfile();
      // Recontar emparejamientos únicos con FutbolFantasy
      if (Object.keys(state.external).length) {
        const nombresVistos = new Set();
        let matched = 0, total = 0;
        document.querySelectorAll(SELECTORS.playerName).forEach((el) => {
          const nombre = el.textContent.trim();
          if (!nombre || nombresVistos.has(nombre)) return;
          nombresVistos.add(nombre);
          total++;
          if (matchExternal(nombre)) matched++;
        });
        state.externalMeta.matched = matched;
        state.externalMeta.visibles = total;
      }
      state.enriched = document.querySelectorAll('[data-mistertools-enriched="true"]').length;
      maybeAutoAnalyze();
      renderPanel();
    } catch (e) {
      E("Error en el escaneo:", e);
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  }

  let observer = null;
  function hookObserver() {
    observer = new MutationObserver((muts) => {
      // Ignoramos nuestras propias inserciones para no realimentar el bucle
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !n.className.toString().includes("mistertools")) {
            scheduleScan();
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    state.observerActive = true;
  }

  let _push, _replace;
  function hookRoutes() {
    _push = history.pushState; _replace = history.replaceState;
    const fire = () => { L("Cambio de ruta detectado:", location.pathname); scheduleScan(); };
    history.pushState = function (...a) { const r = _push.apply(this, a); fire(); return r; };
    history.replaceState = function (...a) { const r = _replace.apply(this, a); fire(); return r; };
    window.addEventListener("popstate", fire);
    window.addEventListener("hashchange", fire);   // Mister usa /team#players/ID
  }


  /* --------------------------------------------------------------------
   * ANÁLISIS BAJO DEMANDA DEL MERCADO
   *
   * Hasta aquí la herramienta sólo observa peticiones que la web ya hace.
   * Este módulo es la única excepción y por eso NUNCA se ejecuta solo:
   * requiere pulsar el botón. Repite exactamente la misma petición que
   * hace Mister al abrir una ficha (POST form-urlencoded a /ajax/sw/players),
   * en serie, con pausa entre llamadas, cacheada y limitada a lo visible.
   * ------------------------------------------------------------------*/
  const analysis = { running: false, done: 0, total: 0, errors: 0,
                     attempted: new Set(), blocked: false, lastError: null };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Jugadores visibles (mercado Y plantilla) sin ficha completa cacheada.
  function pendingPlayers() {
    const out = [], seenIds = new Set();
    document.querySelectorAll(SELECTORS.playerRow).forEach((row) => {
      const a = row.querySelector(SELECTORS.playerLink);
      const av = row.querySelector(SELECTORS.playerAvatar);
      if (!a || !av) return;
      const id = av.getAttribute("data-id_player");
      if (!id || seenIds.has(id)) return;
      if (analysis.attempted.has(id)) return;    // no reintentar en esta sesión
      const m = (a.getAttribute("href") || "").match(/players\/(\d+)\/([^/?#]+)/);
      if (!m) return;
      const api = state.players.get(id) || {};
      if (api.valuesChart || api.clausesRanking != null) return;   // ya cacheado
      seenIds.add(id);
      out.push({ id: id, slug: m[2] });
    });
    return out.slice(0, CONFIG.analysisMaxPlayers);
  }

  async function analyzeMarket(onProgress) {
    if (analysis.running || analysis.blocked) return;
    if (!CONFIG.analysisEnabled) {
      L("El análisis masivo está desactivado: /ajax/sw/players exige una " +
        "cabecera de autenticación que inyecta el Service Worker de Mister y " +
        "que el bookmarklet no puede reproducir. Abre las fichas manualmente: " +
        "sus datos se cachean igual.");
      return;
    }
    const list = pendingPlayers();
    if (!list.length) { renderPanel(); return; }

    if (!replayHeaders) {
      pushLog("Sin cabeceras capturadas todavía: puede fallar con 401");
      L("Aún no he visto ninguna petición de Mister a /ajax/. " +
        "Navega por la web para que la app haga alguna y vuelve a intentarlo.");
    }
    analysis.running = true;
    analysis.done = 0; analysis.errors = 0; analysis.total = list.length;
    pushLog("Analizando " + list.length + " jugadores del mercado");
    L("Analizando mercado:", list.length, "jugadores");

    for (const p of list) {
      if (!analysis.running) break;          // cancelado
      analysis.attempted.add(p.id);
      try {
        const body = "post=players&id=" + encodeURIComponent(p.id) +
                     "&slug=" + encodeURIComponent(p.slug) + "&comments=0";
        // Se usa window.fetch a propósito: nuestro propio interceptor
        // recogerá la respuesta e ingerirá los datos sin código extra.
        const headers = Object.assign({
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest"
        }, replayHeaders || {});
        const res = await window.fetch("/ajax/sw/players", {
          method: "POST",
          credentials: "same-origin",
          headers: headers,
          body: body
        });
        if (!res.ok) {
          analysis.errors++;
          analysis.lastError = "HTTP " + res.status;
          E("Respuesta", res.status, "para", p.slug);
        }
        else analysis.errors = 0;
      } catch (e) {
        analysis.errors++;
        analysis.lastError = String(e && e.message || e);
        E("Fallo al analizar", p.slug, e);
      }
      analysis.done++;
      if (onProgress) onProgress(analysis);
      renderPanel();

      if (analysis.errors >= CONFIG.analysisMaxErrors) {
        // Bloqueo permanente en esta sesión: sin esto, el reescaneo posterior
        // relanzaría el análisis con los siguientes jugadores en bucle.
        analysis.blocked = true;
        CONFIG.autoAnalyze = false;
        pushLog("Análisis BLOQUEADO tras " + analysis.errors + " errores (" +
                (analysis.lastError || "?") + ")");
        E("Análisis bloqueado tras", analysis.errors, "errores seguidos.",
          "No se reintentará. Reactívalo con MisterTools.unblockAnalysis() " +
          "cuando sepamos por qué falla.");
        break;
      }
      await sleep(CONFIG.analysisDelayMs);
    }

    analysis.running = false;
    pushLog("Análisis terminado: " + analysis.done + "/" + analysis.total);
    state.dataVersion++;
    scan();
  }

  // Arranca el análisis solo al entrar a una pantalla con jugadores, una vez
  // por ruta y tras un margen para que la web termine de pintar.
  let autoTimer = null, lastAutoRoute = null;
  function maybeAutoAnalyze() {
    if (!CONFIG.autoAnalyze || analysis.running || analysis.blocked) return;
    const route = location.pathname + location.hash;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (analysis.running) return;
      const pend = pendingPlayers();
      if (!pend.length) return;
      lastAutoRoute = route;
      L("Auto-análisis:", pend.length, "jugadores pendientes");
      analyzeMarket();
    }, CONFIG.autoAnalyzeDelayMs);
  }

  function cancelAnalysis() {
    if (analysis.running) { analysis.running = false; pushLog("Análisis cancelado"); }
  }


  /* --------------------------------------------------------------------
   * CLAUSULAZOS (feed de Inicio)
   *
   * El feed no viaja como JSON accesible (lo sirve el Service Worker), así
   * que se leen del DOM. Cada tarjeta "card-transfer" cuyo texto contiene
   * "pago de cláusula" es un clausulazo. Se acumulan por ID de evento para
   * no duplicar, y persisten en localStorage.
   * ------------------------------------------------------------------*/
  const CKEY = CONFIG.storagePrefix + "clauses";

  function loadClauses() {
    try { state.clauses = JSON.parse(localStorage.getItem(CKEY) || "{}"); }
    catch (e) { state.clauses = {}; }
  }

  let clSaveTimer = null;
  function saveClauses() {
    clearTimeout(clSaveTimer);
    clSaveTimer = setTimeout(() => {
      try { localStorage.setItem(CKEY, JSON.stringify(state.clauses)); }
      catch (e) { E("No se pudo guardar clausulazos:", e); }
    }, 1200);
  }

  // "2d", "13d", "3h" -> timestamp aproximado (el feed sólo da antigüedad relativa)
  function parseRelativeAge(text) {
    if (!text) return Date.now();
    const m = String(text).trim().match(/(\d+)\s*([a-z])/i);
    if (!m) return Date.now();
    const n = parseInt(m[1], 10), u = m[2].toLowerCase();
    const ms = u === "d" ? 864e5 : u === "h" ? 36e5 : u === "m" ? 6e4 : 864e5;
    return Date.now() - n * ms;
  }

  function parseUserLink(a) {
    if (!a) return { id: null, name: null };
    const href = a.getAttribute("href") || "";
    const m = href.match(/users\/(\d+)\/([^/?#]+)/);
    return { id: m ? m[1] : null, name: m ? decodeURIComponent(m[2]).replace(/-/g, " ") : null };
  }

  function scanClauses() {
    try {
      let added = 0;
      document.querySelectorAll(".card-transfer").forEach((card) => {
        const item = card.querySelector(".item .title, .title");
        if (!item) return;
        const txt = item.textContent || "";
        if (txt.toLowerCase().indexOf("pago de cláusula") === -1 &&
            txt.toLowerCase().indexOf("pago de clausula") === -1) return;   // sólo clausulazos

        // ID de evento estable: feed-XXXX
        const idAttr = card.getAttribute("id") || "";
        const evId = idAttr.replace(/^feed-/, "") ||
          // fallback: hash de contenido si no hay id
          String(simpleHash(txt + (card.querySelector("[data-id_player]") || {}).outerHTML));
        if (state.clauses[evId]) return;   // ya registrado

        const av = card.querySelector(".player-avatar[data-id_player]");
        const playerId = av ? av.getAttribute("data-id_player") : null;
        const strong = item.querySelector("strong");
        const playerName = strong ? strong.textContent.trim() : null;

        const users = card.querySelectorAll(".flow a.user, .flow a.avatar.user");
        const from = parseUserLink(users[0]);
        const to = parseUserLink(users[1]);

        const priceEl = card.querySelector(".price");
        const price = priceEl ? parseEuros(priceEl.textContent) : null;

        const dateEl = card.closest(".card-wrapper") &&
          card.closest(".card-wrapper").querySelector(".head .date");
        const ts = parseRelativeAge(dateEl ? dateEl.textContent : "");

        // Nombres del texto como respaldo (el <em> trae vendedor y comprador)
        const ems = item.querySelectorAll("em");
        state.clauses[evId] = {
          ts: ts,
          playerId: playerId,
          playerName: playerName,
          price: price,
          fromId: from.id, fromName: from.name || (ems[0] && ems[0].textContent.trim()),
          toId: to.id, toName: to.name || (ems[1] && ems[1].textContent.trim())
        };
        added++;
      });
      if (added) {
        saveClauses();
        state.dataVersion++;
        pushLog(added + " clausulazo(s) nuevo(s) registrados");
        L(added + " clausulazos nuevos");
        renderPanel();
      }
    } catch (e) { E("Error leyendo clausulazos:", e); }
  }

  // Agrupa por mánager: { managerId: {name, recibidos:[], hechos:[]} }
  function clausesByManager() {
    const out = {};
    const ensure = (id, name) => {
      if (!id) return null;
      if (!out[id]) out[id] = { id: id, name: name, recibidos: [], hechos: [] };
      else if (name && !out[id].name) out[id].name = name;
      return out[id];
    };
    Object.keys(state.clauses).forEach((k) => {
      const c = state.clauses[k];
      // "recibido" = te robaron un jugador (eras el 'from', el vendedor forzado)
      const victim = ensure(c.fromId, c.fromName);
      if (victim) victim.recibidos.push(c);
      // "hecho" = tú robaste (eras el 'to', el que paga la cláusula)
      const robber = ensure(c.toId, c.toName);
      if (robber) robber.hechos.push(c);
    });
    Object.values(out).forEach((m) => {
      m.recibidos.sort((a, b) => b.ts - a.ts);
      m.hechos.sort((a, b) => b.ts - a.ts);
    });
    return out;
  }



  /* Panel de clausulazos dentro de la ficha de un mánager.
   * Se inserta una sola vez por ficha, identificando al mánager por la URL
   * (users/ID) o por el enlace activo. Si no se encuentra un punto de anclaje
   * fiable, no se hace nada (nunca rompe la web). */
  function enrichManagerProfile() {
    try {
      // Detectar el mánager por la URL (…users/ID…) o por el hash.
      const m = (location.href.match(/users\/(\d+)/) || []);
      const managerId = m[1] || null;
      if (!managerId) return;

      const grouped = clausesByManager();
      const data = grouped[managerId];
      if (!data || (!data.recibidos.length && !data.hechos.length)) return;

      if (document.querySelector(".mistertools-clause-box")) return;  // ya inyectado

      // Anclaje en el panel de ESTADÍSTICAS, encima del "Palmarés".
      // Verificado en el DOM real (standings#users/ID). El panel existe aunque
      // esté oculto; lo insertamos igual y se ve al cambiar a esa pestaña.
      const stats = document.querySelector(".panel-stats");
      if (!stats) return;
      const sectionTitle = stats.querySelector(".section-title");
      const anchor = sectionTitle || stats.firstElementChild;
      if (!anchor) return;

      const sum = (arr) => arr.reduce((a, c) => a + (c.price || 0), 0);

      const box = document.createElement("div");
      box.className = "mistertools-clause-box";

      const title = document.createElement("div");
      title.className = "mistertools-clause-title";
      title.textContent = "⚔️ Clausulazos" + (data.name ? " · " + data.name : "");
      box.appendChild(title);

      const mkList = (arr, kind) => {
        const total = sum(arr);
        const h = document.createElement("div");
        h.className = "mistertools-clause-sub";
        h.textContent = (kind === "in" ? "🟥 Recibidos: " : "🟩 Hechos: ") +
          arr.length + " · " + formatCurrency(total);
        box.appendChild(h);
        arr.slice(0, 10).forEach((c) => {
          const r = document.createElement("div");
          r.className = "mistertools-clause-row";
          const other = kind === "in" ? (c.toName || "?") : (c.fromName || "?");
          const arrow = kind === "in" ? " → " : " ← ";
          r.textContent = formatDateShort(c.ts) + "  " + (c.playerName || "?") +
            " · " + formatCompactCurrency(c.price) + arrow + other;
          box.appendChild(r);
        });
      };
      mkList(data.recibidos, "in");
      mkList(data.hechos, "out");

      stats.insertBefore(box, anchor);
      pushLog("Clausulazos mostrados en ficha de " + (data.name || managerId));
    } catch (e) { E("Error inyectando clausulazos en perfil:", e); }
  }

  /* --------------------------------------------------------------------
   * ESTILOS
   * ------------------------------------------------------------------*/
  function injectStyles() {
    if (document.getElementById("mistertools-styles")) return;
    const s = document.createElement("style");
    s.id = "mistertools-styles";
    s.textContent = `
.mistertools-badge-row{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.mistertools-clause-box{background:#0d1830;border:1px solid #1e5fff;border-radius:8px;
 padding:10px 12px;margin:10px 0;font-family:system-ui,sans-serif;color:#fff}
.mistertools-clause-title{font-weight:700;font-size:13px;margin-bottom:6px}
.mistertools-clause-sub{font-size:11px;color:#9db4ff;margin:6px 0 3px}
.mistertools-clause-row{font-size:12px;padding:2px 0;border-bottom:1px solid #16223f}
.mistertools-badge{display:inline-block;padding:2px 6px;border-radius:3px;
 font-size:11px;font-weight:700;line-height:1.45;color:#fff;background:#2c5aa0;
 white-space:nowrap;font-family:system-ui,sans-serif}
.mistertools-badge--success{background:#1e8f4e}
.mistertools-badge--danger{background:#c0392b}
.mistertools-badge--warning{background:#d35400}
.mistertools-badge--estimate{background:#b58900}
.mistertools-badge--neutral{background:#334}
.mistertools-badge--clickable{cursor:pointer;text-decoration:underline}
.mistertools-badge--est{border:1px dashed rgba(255,255,255,.55)}
.mistertools-fab{position:fixed;bottom:20px;right:20px;z-index:2147483000;
 width:48px;height:48px;border-radius:50%;background:#0b1f3a;color:#fff;
 border:2px solid #1e5fff;font:700 13px system-ui,sans-serif;cursor:pointer;
 box-shadow:0 2px 10px rgba(0,0,0,.45)}
.mistertools-panel{position:fixed;top:0;right:0;height:100%;width:360px;
 max-width:100vw;background:#0b1220;color:#fff;z-index:2147483001;
 font:13px system-ui,sans-serif;display:flex;flex-direction:column;
 box-shadow:-4px 0 20px rgba(0,0,0,.5)}
.mistertools-head{display:flex;align-items:center;justify-content:space-between;
 padding:10px 12px;background:#071224;border-bottom:1px solid #1e5fff}
.mistertools-head h2{margin:0;font-size:14px}
.mistertools-head button{background:none;border:none;color:#9db4ff;
 font-size:16px;cursor:pointer;margin-left:10px;padding:4px 8px}
.mistertools-tabs{display:flex;background:#0d1830;border-bottom:1px solid #1e2c4d}
.mistertools-tab{flex:1;padding:9px 4px;text-align:center;cursor:pointer;
 color:#9db4ff;font-size:11px;border-bottom:2px solid transparent}
.mistertools-tab--on{color:#fff;border-bottom-color:#1e5fff;background:#0b1220}
.mistertools-body{flex:1;overflow-y:auto;padding:10px 12px}
.mistertools-line{display:flex;justify-content:space-between;gap:8px;
 padding:5px 0;border-bottom:1px solid #16223f}
.mistertools-line span{color:#9db4ff}
.mistertools-line strong{text-align:right;word-break:break-all}
.mistertools-btn--danger{background:#c0392b}
.mistertools-btn{background:#1e5fff;color:#fff;border:none;padding:7px 12px;
 border-radius:4px;cursor:pointer;font-size:11px;margin:6px 6px 0 0}
.mistertools-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);
 z-index:2147483002;display:flex;align-items:center;justify-content:center;padding:16px}
.mistertools-modal{background:#0b1220;color:#fff;border:1px solid #1e5fff;
 border-radius:8px;padding:18px;width:320px;max-width:100%;
 font:13px system-ui,sans-serif}
.mistertools-modal h3{margin:0 0 12px;font-size:15px}
.mistertools-modal-row{display:flex;justify-content:space-between;gap:10px;
 padding:5px 0;font-size:12px;border-bottom:1px solid #16223f}
.mistertools-modal-row span{color:#9db4ff;font-size:10px;letter-spacing:.04em}
.mistertools-note{font-size:10px;color:#9db4ff;margin:12px 0 0;line-height:1.5}
.mistertools-log{font-size:10px;padding:3px 0;border-bottom:1px solid #16223f;color:#cfd8ff}
@media(max-width:600px){
 .mistertools-panel{width:100vw;height:88vh;top:auto;bottom:0;border-radius:12px 12px 0 0}
 .mistertools-badge{font-size:12px;padding:4px 8px}
 .mistertools-tab{padding:12px 4px;font-size:12px}
 .mistertools-fab{width:56px;height:56px;bottom:16px;right:16px;font-size:15px}
}`;
    document.head.appendChild(s);
  }

  /* --------------------------------------------------------------------
   * PANEL
   * ------------------------------------------------------------------*/
  const TABS = ["Estado", "Datos", "Clausulazos", "API", "Jugadores", "Mánagers", "Config", "Logs"];
  let panel = null, fab = null, tab = "Estado";

  function line(k, v) {
    const d = document.createElement("div");
    d.className = "mistertools-line";
    const a = document.createElement("span"); a.textContent = k;
    const b = document.createElement("strong"); b.textContent = String(v);
    d.append(a, b);
    return d;
  }

  function openPanel() {
    panel = document.createElement("div");
    panel.className = "mistertools-panel";

    const head = document.createElement("div");
    head.className = "mistertools-head";
    const h = document.createElement("h2");
    h.textContent = "MisterTools " + CONFIG.version;
    const btns = document.createElement("div");
    const bMin = document.createElement("button"); bMin.textContent = "—";
    bMin.title = "Minimizar";
    bMin.addEventListener("click", closePanel);
    const bDel = document.createElement("button"); bDel.textContent = "✕";
    bDel.title = "Eliminar MisterTools";
    bDel.addEventListener("click", destroy);
    btns.append(bMin, bDel);
    head.append(h, btns);

    const tabs = document.createElement("div");
    tabs.className = "mistertools-tabs";
    TABS.forEach((t) => {
      const el = document.createElement("div");
      el.className = "mistertools-tab" + (t === tab ? " mistertools-tab--on" : "");
      el.textContent = t;
      el.addEventListener("click", () => { tab = t; renderPanel(); });
      tabs.appendChild(el);
    });

    const body = document.createElement("div");
    body.className = "mistertools-body";

    panel.append(head, tabs, body);
    document.body.appendChild(panel);
    renderPanel();
  }

  function closePanel() { if (panel) { panel.remove(); panel = null; } }

  function renderPanel() {
    if (!panel) return;
    panel.querySelectorAll(".mistertools-tab").forEach((el) =>
      el.classList.toggle("mistertools-tab--on", el.textContent === tab));
    const body = panel.querySelector(".mistertools-body");
    body.innerHTML = "";

    if (tab === "Estado") {
      const max = calculateMaximumBid();
      body.append(
        line("Mánager", state.me.name || "—"),
        line("Liga", state.community.name || "—"),
        line("Valor de equipo", formatCurrency(state.me.teamValue)),
        line("Saldo actual", formatCurrency(state.balance.current)),
        line("Saldo futuro", formatCurrency(state.balance.future)),
        line("PUJA MÁXIMA", formatCurrency(max.value) + (max.estimated ? " (est.)" : "")),
        line("Margen de deuda", (100 / state.community.maxDebtDivisor).toFixed(0) + " %"),
        line("Ruta", location.pathname),
        line("Respuestas API", state.endpoints.length),
        line("Jugadores", state.players.size),
        line("Mánagers", state.managers.size),
        line("Elementos enriquecidos", state.enriched),
        line("Observer", state.observerActive ? "activo" : "inactivo"),
        line("fetch / XHR", (state.fetchOk ? "ok" : "no") + " / " + (state.xhrOk ? "ok" : "no"))
      );
      const b = document.createElement("button");
      b.className = "mistertools-btn"; b.textContent = "Reescanear";
      b.addEventListener("click", scan);
      body.appendChild(b);

      const pend = pendingPlayers().length;
      if (!CONFIG.analysisEnabled) {
        const info = document.createElement("p");
        info.className = "mistertools-note";
        info.textContent = "Análisis masivo no disponible: Mister protege esas " +
          "peticiones con un token que gestiona su Service Worker. Abre la ficha " +
          "de un jugador y sus datos quedan guardados; la variación diaria del " +
          "resto del mercado aparece a partir del día siguiente.";
        body.appendChild(info);
        return;
      }
      const ab = document.createElement("button");
      ab.className = "mistertools-btn";
      if (analysis.running) {
        ab.textContent = "Cancelar (" + analysis.done + "/" + analysis.total + ")";
        ab.addEventListener("click", cancelAnalysis);
      } else {
        ab.textContent = pend ? "Analizar visibles (" + pend + ")" : "Todo analizado";
        ab.disabled = !pend;
        if (pend) ab.addEventListener("click", () => analyzeMarket());
      }
      body.appendChild(ab);

      const note = document.createElement("p");
      note.className = "mistertools-note";
      if (analysis.blocked) {
        const warn = document.createElement("p");
        warn.className = "mistertools-note";
        warn.style.color = "#ff8a80";
        warn.textContent = "Análisis bloqueado: la API respondió " +
          (analysis.lastError || "con error") + ". No se reintentará.";
        body.appendChild(warn);
      }
      note.textContent = "El análisis pide a Mister la ficha de cada jugador visible, " +
        "una a una y con " + CONFIG.analysisDelayMs + " ms de pausa, igual que si las " +
        "abrieras tú. Puedes desactivar el modo automático en Config.";
      body.appendChild(note);
    }

    else if (tab === "Datos") {
      const count = state.players.size;
      const histCount = Object.keys(history).length;
      body.appendChild(line("Jugadores en memoria", count));
      body.appendChild(line("Con histórico diario", histCount));
      body.appendChild(line("Fuente remota", CONFIG.dataUrl ? "configurada" : "no"));
      body.appendChild(line("FutbolFantasy", state.externalMeta.total + " jugadores"));
      body.appendChild(line("Emparejados (en pantalla)", state.externalMeta.matched + " / " + (state.externalMeta.visibles || 0)));
      if (CONFIG.externalUrl) {
        const rb = document.createElement("button");
        rb.className = "mistertools-btn";
        rb.textContent = "🔄 Recargar titularidades";
        rb.addEventListener("click", () => loadExternalData());
        body.appendChild(rb);
      }

      const mkBtn = (label, fn, danger) => {
        const b = document.createElement("button");
        b.className = "mistertools-btn" + (danger ? " mistertools-btn--danger" : "");
        b.textContent = label;
        b.addEventListener("click", fn);
        body.appendChild(b);
        return b;
      };

      const subir = mkBtn("☁️ Subir a GitHub", async () => {
        if (!window.MisterTools.hasToken()) {
          subir.textContent = "Configura el token en Config →";
          return;
        }
        subir.textContent = "Subiendo…";
        const r = await uploadToGitHub();
        subir.textContent = r.ok ? "✅ Subido" :
          r.reason === "token-invalido" ? "❌ Token inválido" :
          r.reason === "sin-token" ? "Configura el token en Config" :
          "❌ Error (" + (r.reason||"?") + ")";
        setTimeout(() => { subir.textContent = "☁️ Subir a GitHub"; }, 4000);
      });
      mkBtn("⬇ Exportar a archivo", () => {
        const n = exportData();
        if (n) pushLog(n + " jugadores exportados");
      });
      mkBtn("⬆ Importar de archivo", importDataFromFile);
      if (CONFIG.dataUrl) mkBtn("🔄 Recargar remoto", () => loadRemoteData());

      const note = document.createElement("p");
      note.className = "mistertools-note";
      note.textContent = "Exportar guarda en un archivo todo lo que has visto navegando " +
        "(valores, cláusulas, rankings, histórico). Impórtalo en otro dispositivo, " +
        "o súbelo a tu web para que se cargue solo. No incluye contraseñas ni tokens.";
      body.appendChild(note);
    }

    else if (tab === "Clausulazos") {
      const total = Object.keys(state.clauses).length;
      body.appendChild(line("Clausulazos registrados", total));
      if (!total) {
        const n = document.createElement("p");
        n.className = "mistertools-note";
        n.textContent = "Ve a Inicio y desplázate por el feed: los pagos de cláusula " +
          "se guardan automáticamente. Sólo desde hoy; los anteriores al reinicio no " +
          "son recuperables.";
        body.appendChild(n);
      }
      const grouped = clausesByManager();
      Object.values(grouped)
        .sort((a, b) => (b.recibidos.length + b.hechos.length) - (a.recibidos.length + a.hechos.length))
        .forEach((m) => {
          const h = document.createElement("div");
          h.style.cssText = "margin:10px 0 4px;color:#fff;font-weight:700;font-size:12px";
          h.textContent = m.name || m.id;
          body.appendChild(h);
          const sumR = m.recibidos.reduce((a, c) => a + (c.price || 0), 0);
          const sumH = m.hechos.reduce((a, c) => a + (c.price || 0), 0);
          const sub = document.createElement("div");
          sub.style.cssText = "font-size:11px;color:#9db4ff;margin-bottom:4px";
          sub.textContent = "🟥 " + m.recibidos.length + " (" + formatCompactCurrency(sumR) +
                            ")   🟩 " + m.hechos.length + " (" + formatCompactCurrency(sumH) + ")";
          body.appendChild(sub);
          m.recibidos.slice(0, 5).forEach((c) => {
            const d = document.createElement("div");
            d.className = "mistertools-log";
            d.textContent = formatDateShort(c.ts) + " 🟥 " + (c.playerName || "?") + " · " +
              formatCompactCurrency(c.price) + " → " + (c.toName || "?");
            body.appendChild(d);
          });
          m.hechos.slice(0, 5).forEach((c) => {
            const d = document.createElement("div");
            d.className = "mistertools-log";
            d.textContent = formatDateShort(c.ts) + " 🟩 " + (c.playerName || "?") + " · " +
              formatCompactCurrency(c.price) + " ← " + (c.fromName || "?");
            body.appendChild(d);
          });
        });
    }

    else if (tab === "API") {
      const b = document.createElement("button");
      b.className = "mistertools-btn"; b.textContent = "Copiar resumen técnico";
      b.addEventListener("click", () => {
        navigator.clipboard.writeText(exportTechnicalSummary())
          .then(() => L("Resumen copiado"), () => E("No se pudo copiar"));
      });
      body.appendChild(b);
      state.endpoints.forEach((e) => {
        const d = line(e.method + " " + e.url + (e.write ? " ⚠" : ""),
          e.status + " · " + new Date(e.time).toLocaleTimeString("es-ES"));
        d.style.cursor = "pointer";
        d.addEventListener("click", () => showStructure(e));
        body.appendChild(d);
      });
    }

    else if (tab === "Jugadores") {
      Array.from(state.players.values()).slice(0, 150).forEach((p) => {
        body.appendChild(line(
          (POSITIONS[p.position] || "?") + " " + p.name,
          formatCompactCurrency(p.value)));
      });
    }

    else if (tab === "Mánagers") {
      Array.from(state.managers.values()).forEach((m) => {
        body.appendChild(line((m.isMe ? "★ " : "") + (m.name || m.id),
          formatCompactCurrency(m.teamValue)));
      });
    }

    else if (tab === "Config") {
      body.appendChild(line("Versión", CONFIG.version));
      body.appendChild(line("Divisor de deuda", state.community.maxDebtDivisor));
      const lab = document.createElement("div");
      lab.style.cssText = "margin:10px 0 6px;color:#9db4ff;font-size:11px";
      lab.textContent = "Margen de puja sobre el valor de equipo:";
      body.appendChild(lab);
      const sel = document.createElement("select");
      sel.style.cssText = "background:#0d1830;color:#fff;border:1px solid #1e5fff;padding:6px;border-radius:4px;width:100%";
      [["Sin margen (0 %)", 0], ["25 % (divisor 4)", 4], ["50 % (divisor 2)", 2], ["100 % (divisor 1)", 1]]
        .forEach(([t, v]) => {
          const o = document.createElement("option");
          o.value = v; o.textContent = t;
          if (state.community.maxDebtDivisor === v) o.selected = true;
          sel.appendChild(o);
        });
      sel.addEventListener("change", () => {
        state.community.maxDebtDivisor = parseInt(sel.value, 10) || 1;
        try {
          localStorage.setItem(CONFIG.storagePrefix + "divisor", sel.value);
        } catch (e) {}
        document.querySelectorAll("[data-mistertools-enriched]").forEach((el) => {
          el.removeAttribute("data-mistertools-enriched");
          el.removeAttribute("data-mistertools-v");
          const r = el.querySelector(":scope .mistertools-badge-row");
          if (r) r.remove();
        });
        scan();
      });
      body.appendChild(sel);
      const n = document.createElement("p");
      n.className = "mistertools-note";
      n.textContent = "Se detecta automáticamente desde la configuración de la liga. " +
        "Solo cámbialo si tu liga usa otro margen.";
      body.appendChild(n);

      const toggle = (label, key, tip) => {
        const w = document.createElement("label");
        w.style.cssText = "display:flex;gap:8px;align-items:center;margin:10px 0;cursor:pointer";
        const c = document.createElement("input");
        c.type = "checkbox"; c.checked = !!CONFIG[key];
        c.addEventListener("change", () => {
          CONFIG[key] = c.checked;
          try { localStorage.setItem(CONFIG.storagePrefix + key, c.checked ? "1" : "0"); } catch (e) {}
          document.querySelectorAll("[data-mistertools-enriched]").forEach((el) => {
            el.removeAttribute("data-mistertools-enriched");
            el.removeAttribute("data-mistertools-v");
          });
          document.querySelectorAll(".mistertools-badge-row").forEach((el) => el.remove());
          scan();
        });
        const t = document.createElement("span");
        t.textContent = label; t.style.fontSize = "12px";
        if (tip) w.title = tip;
        w.append(c, t);
        body.appendChild(w);
      };
      toggle("Mostrar todos los badges", "expandBadges",
        "Desactivado muestra sólo los " + CONFIG.maxBadgesCompact + " más relevantes");
      toggle("Analizar automáticamente al entrar", "autoAnalyze",
        "Pide las fichas de los jugadores visibles al abrir plantilla o mercado");

      // --- Token de GitHub para la subida automática ---
      const ghTitle = document.createElement("div");
      ghTitle.style.cssText = "margin:14px 0 4px;color:#fff;font-weight:700;font-size:12px";
      ghTitle.textContent = "Subida a GitHub";
      body.appendChild(ghTitle);

      const ghState = document.createElement("div");
      ghState.style.cssText = "font-size:11px;color:#9db4ff;margin-bottom:6px";
      ghState.textContent = window.MisterTools.hasToken()
        ? "✅ Token configurado. La subida está activa."
        : "Sin token. Pega abajo tu token de GitHub para activar la subida.";
      body.appendChild(ghState);

      const ghInput = document.createElement("input");
      ghInput.type = "password";
      ghInput.placeholder = "github_pat_...";
      ghInput.style.cssText = "width:100%;background:#0d1830;color:#fff;border:1px solid #1e5fff;padding:6px;border-radius:4px;box-sizing:border-box";
      body.appendChild(ghInput);

      const ghSave = document.createElement("button");
      ghSave.className = "mistertools-btn";
      ghSave.textContent = "Guardar token";
      ghSave.addEventListener("click", () => {
        if (ghInput.value.trim()) {
          window.MisterTools.setGitHubToken(ghInput.value);
          ghInput.value = "";
          ghState.textContent = "✅ Token configurado. La subida está activa.";
        }
      });
      body.appendChild(ghSave);

      if (window.MisterTools.hasToken()) {
        const ghDel = document.createElement("button");
        ghDel.className = "mistertools-btn mistertools-btn--danger";
        ghDel.textContent = "Borrar token";
        ghDel.addEventListener("click", () => {
          window.MisterTools.setGitHubToken(null);
          ghState.textContent = "Token borrado.";
        });
        body.appendChild(ghDel);
      }

      const ghNote = document.createElement("p");
      ghNote.className = "mistertools-note";
      ghNote.textContent = "El token se guarda solo en este navegador, nunca se " +
        "comparte. Usa un token restringido a tu repo (contents: write).";
      body.appendChild(ghNote);
    }

    else if (tab === "Logs") {
      state.logs.slice(0, 80).forEach((l) => {
        const d = document.createElement("div");
        d.className = "mistertools-log";
        d.textContent = "[" + new Date(l.t).toLocaleTimeString("es-ES") + "] " + l.m;
        body.appendChild(d);
      });
    }
  }

  function showStructure(entry) {
    const ov = document.createElement("div");
    ov.className = "mistertools-overlay";
    const box = document.createElement("div");
    box.className = "mistertools-modal";
    box.style.width = "440px";
    const h = document.createElement("h3");
    h.textContent = entry.method + " " + entry.url;
    const pre = document.createElement("pre");
    pre.style.cssText = "max-height:55vh;overflow:auto;font-size:10px;white-space:pre-wrap;color:#cfd8ff";
    pre.textContent = JSON.stringify(entry.sample, null, 2);
    const b = document.createElement("button");
    b.className = "mistertools-btn"; b.textContent = "Cerrar";
    b.addEventListener("click", () => ov.remove());
    box.append(h, pre, b);
    ov.appendChild(box);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }


  /* --------------------------------------------------------------------
   * EXPORT / IMPORT DE DATOS (Bloque 1)
   *
   * Vuelca a un JSON todo lo capturado navegando: fichas de jugador,
   * mánagers y el histórico diario de valores. Sirve para:
   *   - Persistir entre sesiones y dispositivos.
   *   - Alimentar el JSON que en el Bloque 2 se alojará en GitHub Pages,
   *     para que el iPhone lea los datos sin tener que abrir fichas.
   * Sólo datos de juego: ni cabeceras, ni tokens, ni cookies.
   * ------------------------------------------------------------------*/
  const DATA_FORMAT = 2;

  function buildDataset() {
    const players = {};
    state.players.forEach((p, id) => {
      // Sólo se exporta lo que tiene valor informativo y no es sensible.
      players[id] = {
        id: id, name: p.name, position: p.position,
        value: p.value, previousValue: p.previousValue,
        points: p.points, avg: p.avg,
        clause: p.clause ? { floor: p.clause.floor, multiplier: p.clause.multiplier,
                             value: p.clause.value, percentage: p.clause.percentage } : null,
        clausesRanking: p.clausesRanking,
        pointsHistory: p.pointsHistory,
        values: p.values,
        valuesChart: p.valuesChart,
        nextMatch: p.nextMatch ? { place: p.nextMatch.place, home: p.nextMatch.home,
                                   away: p.nextMatch.away } : null,
        injury: p.injury && p.injury.length ? 1 : 0
      };
    });
    return {
      format: DATA_FORMAT,
      generatedBy: CONFIG.version,
      generatedAt: new Date().toISOString(),
      community: state.community,
      players: players,
      history: history,           // snapshots diarios por jugador
      clauses: state.clauses      // clausulazos del feed
    };
  }


  /* --------------------------------------------------------------------
   * SUBIDA AUTOMÁTICA A GITHUB
   *
   * El token NUNCA está en el código (el repo es público). Lo guarda el
   * usuario en localStorage de SU navegador, con permiso restringido a un
   * solo repo. Aquí solo se lee de ahí para autenticar la petición.
   * ------------------------------------------------------------------*/
  const TOKEN_KEY = CONFIG.storagePrefix + "gh_token";

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t.trim());
      else localStorage.removeItem(TOKEN_KEY);
      return true;
    } catch (e) { E("No se pudo guardar el token:", e); return false; }
  }

  // Codifica a base64 respetando UTF-8 (nombres con acentos).
  function toBase64Utf8(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  async function uploadToGitHub() {
    const token = getToken();
    if (!token) {
      L("No hay token configurado. Pégalo en la pestaña Config para activar la subida.");
      return { ok: false, reason: "sin-token" };
    }
    const api = "https://api.github.com/repos/" + CONFIG.githubRepo +
                "/contents/" + CONFIG.githubDataPath;
    try {
      // 1) Necesitamos el 'sha' del archivo actual para poder reemplazarlo.
      let sha = null;
      const getRes = await fetch(api + "?ref=" + CONFIG.githubBranch, {
        headers: { "Authorization": "token " + token,
                   "Accept": "application/vnd.github+json" }
      });
      if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
      else if (getRes.status === 401) {
        return { ok: false, reason: "token-invalido" };
      }

      // 2) PUT con el nuevo contenido.
      const contenido = JSON.stringify(buildDataset(), null, 2);
      const body = {
        message: "MisterTools: actualiza datos.json (" + new Date().toISOString() + ")",
        content: toBase64Utf8(contenido),
        branch: CONFIG.githubBranch
      };
      if (sha) body.sha = sha;

      const putRes = await fetch(api, {
        method: "PUT",
        headers: { "Authorization": "token " + token,
                   "Accept": "application/vnd.github+json",
                   "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (putRes.ok) {
        pushLog("datos.json subido a GitHub");
        L("Subida correcta. Los demás dispositivos lo verán al recargar.");
        return { ok: true };
      }
      const err = await putRes.json().catch(() => ({}));
      E("Fallo al subir:", putRes.status, err.message || "");
      return { ok: false, reason: "http-" + putRes.status, message: err.message };
    } catch (e) {
      E("Error de red al subir a GitHub:", e);
      return { ok: false, reason: "red" };
    }
  }

  function exportData() {
    try {
      const data = buildDataset();
      const json = JSON.stringify(data);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mistertools-datos-" + today() + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      const n = Object.keys(data.players).length;
      pushLog("Exportados " + n + " jugadores");
      L("Exportados " + n + " jugadores a " + a.download);
      return n;
    } catch (e) { E("Error al exportar:", e); return 0; }
  }

  // Funde un dataset en el estado actual. No pisa datos más recientes que ya
  // tengamos: el import es aditivo, pensado para combinar varios volcados.
  function mergeDataset(data) {
    if (!data || !data.players) { E("Dataset inválido"); return 0; }
    let n = 0;
    for (const id in data.players) {
      const inc = data.players[id];
      const cur = state.players.get(id) || {};
      state.players.set(id, {
        id: id,
        name: inc.name || cur.name,
        position: inc.position != null ? inc.position : cur.position,
        value: inc.value != null ? inc.value : cur.value,
        previousValue: inc.previousValue != null ? inc.previousValue : cur.previousValue,
        points: inc.points != null ? inc.points : cur.points,
        avg: inc.avg != null ? inc.avg : cur.avg,
        clause: inc.clause || cur.clause,
        clausesRanking: inc.clausesRanking != null ? inc.clausesRanking : cur.clausesRanking,
        pointsHistory: inc.pointsHistory || cur.pointsHistory,
        values: inc.values || cur.values,
        valuesChart: inc.valuesChart || cur.valuesChart,
        nextMatch: inc.nextMatch || cur.nextMatch,
        injury: inc.injury ? [1] : cur.injury
      });
      n++;
    }
    // Fusión del histórico: conservamos el mayor número de snapshots por jugador.
    if (data.history) {
      for (const id in data.history) {
        const inc = data.history[id];
        if (!history[id] || (inc.s && inc.s.length > (history[id].s || []).length)) {
          history[id] = inc;
        }
      }
      saveHistory();
    }
    if (data.clauses) {
      for (const k in data.clauses) {
        if (!state.clauses[k]) state.clauses[k] = data.clauses[k];
      }
      saveClauses();
    }
    state.dataVersion++;
    L("Importados " + n + " jugadores");
    pushLog("Importados " + n + " jugadores");
    scan();
    return n;
  }

  function importDataFromFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try { mergeDataset(JSON.parse(reader.result)); }
        catch (e) { E("Archivo JSON no válido:", e); }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  // Carga un dataset desde una URL (GitHub Pages en el Bloque 2).

  /* --------------------------------------------------------------------
   * DATOS EXTERNOS (FutbolFantasy · Bloque 4)
   * Titularidad, estado, rival. Se cruzan con los jugadores de Mister por
   * nombre normalizado. El emparejamiento es imperfecto (nombres abreviados
   * en Mister), así que llevamos la cuenta de aciertos.
   * ------------------------------------------------------------------*/
  const ESTADO_ORDEN = { "Dios": 6, "Clave": 5, "Importante": 4, "Rotación": 3,
                         "Revulsivo": 2, "Reserva": 1 };

  async function loadExternalData(url) {
    const target = url || CONFIG.externalUrl;
    if (!target) return 0;
    try {
      const res = await fetch(target, { cache: "no-store" });
      if (!res.ok) { E("externo.json respondió", res.status); return 0; }
      const data = await res.json();
      if (data.bloqueado) { L("El scraper externo está bloqueado."); return 0; }
      state.external = data.porNombre || {};
      state.externalMeta = {
        total: data.total || Object.keys(state.external).length,
        matched: 0,
        generatedAt: data.generatedAt || null
      };
      L("Datos externos cargados:", state.externalMeta.total, "jugadores");
      pushLog("FutbolFantasy: " + state.externalMeta.total + " jugadores");
      state.dataVersion++;
      scan();
      return state.externalMeta.total;
    } catch (e) { E("No se pudo cargar externo.json:", e); return 0; }
  }

  // Devuelve el registro externo que corresponde a un jugador de Mister.
  // Estrategia por capas: nombre normalizado exacto -> apellido -> null.
  function matchExternal(playerName) {
    if (!playerName || !state.external) return null;
    const norm = normalizeName(playerName);
    if (state.external[norm]) return state.external[norm];

    // Nombre abreviado tipo "G. Guedes" -> intentamos por el apellido final.
    const parts = norm.split(" ");
    const apellido = parts[parts.length - 1];
    if (apellido && apellido.length > 3) {
      // Buscar un externo cuyo nombre normalizado termine igual y sea único.
      const cands = [];
      for (const k in state.external) {
        const kp = k.split(" ");
        if (kp[kp.length - 1] === apellido) cands.push(state.external[k]);
      }
      if (cands.length === 1) return cands[0];
    }
    return null;
  }

  function externalBadgesFor(playerName) {
    const ext = matchExternal(playerName);
    if (!ext) return [];
    const badges = [];

    if (ext.probabilidad != null) {
      const p = ext.probabilidad;
      const tipo = p >= 75 ? "success" : p >= 50 ? "warning" : "danger";
      badges.push({
        p: 90,   // titularidad: prioridad alta
        text: "👕 " + p + "%" + (ext.estado ? " · " + ext.estado : ""),
        type: tipo,
        tip: "Probabilidad de ser titular según FutbolFantasy" +
             (ext.estado ? " · rol: " + ext.estado : "") +
             (ext.rival ? " · próximo: " + (ext.local ? "vs " : "@") + ext.rival : "")
      });
    }
    if (ext.lesionado) {
      badges.push({ p: 100, text: "🚑 Lesionado", type: "danger",
        tip: "Marcado como lesionado en FutbolFantasy" });
    }
    return badges;
  }

  async function loadRemoteData(url) {
    const target = url || CONFIG.dataUrl;
    if (!target) { L("No hay dataUrl configurada."); return 0; }
    try {
      L("Cargando datos remotos de", target);
      const res = await fetch(target, { cache: "no-store" });
      if (!res.ok) { E("La URL de datos respondió", res.status); return 0; }
      const data = await res.json();
      const n = mergeDataset(data);
      pushLog("Datos remotos cargados: " + n + " jugadores");
      return n;
    } catch (e) { E("No se pudieron cargar los datos remotos:", e); return 0; }
  }

  function exportTechnicalSummary() {
    const out = ["MisterTools " + CONFIG.version, new Date().toISOString(),
      "host: " + location.hostname, ""];
    state.endpoints.forEach((e) => {
      out.push(e.method + " " + e.url + " [" + e.status + "]" + (e.write ? " (escritura)" : ""));
      out.push("  campos: " + e.fields.join(", "));
    });
    return out.join("\n");
  }

  /* --------------------------------------------------------------------
   * CICLO DE VIDA
   * ------------------------------------------------------------------*/
  function destroy() {
    try {
      if (observer) observer.disconnect();
      if (fab) fab.remove();
      closePanel();
      document.querySelectorAll(".mistertools-overlay").forEach((e) => e.remove());
      document.querySelectorAll(".mistertools-badge-row").forEach((e) => e.remove());
      document.querySelectorAll("[data-mistertools-enriched]").forEach((e) => {
        e.removeAttribute("data-mistertools-enriched");
        e.removeAttribute("data-mistertools-v");
      });
      const st = document.getElementById("mistertools-styles");
      if (st) st.remove();
      window.fetch = _fetch;
      if (XP) { XP.open = _open; XP.send = _send; XP.setRequestHeader = _srh; }
      if (_push) history.pushState = _push;
      if (_replace) history.replaceState = _replace;
      L("Herramienta eliminada");
      delete window.MisterTools;
    } catch (e) { E("Error al destruir:", e); }
  }

  function init() {
    try {
      try {
        const d = localStorage.getItem(CONFIG.storagePrefix + "divisor");
        if (d) state.community.maxDebtDivisor = parseInt(d, 10) || 4;
        ["expandBadges", "autoAnalyze"].forEach((k) => {
          const v = localStorage.getItem(CONFIG.storagePrefix + k);
          if (v !== null) CONFIG[k] = v === "1";
        });
      } catch (e) {}

      loadHistory();
      loadClauses();
      injectStyles();
      hookFetch();
      hookXhr();
      hookRoutes();
      hookObserver();

      fab = document.createElement("button");
      fab.className = "mistertools-fab";
      fab.textContent = "MT";
      fab.addEventListener("click", () => panel ? closePanel() : openPanel());
      document.body.appendChild(fab);

      scan();
      if (CONFIG.autoLoadRemote && CONFIG.dataUrl) loadRemoteData();
      if (CONFIG.autoLoadRemote && CONFIG.externalUrl) loadExternalData();
      pushLog("Inicializado " + CONFIG.version);
    } catch (e) { E("Error en init:", e); }
  }

  window.MisterTools = {
    __running: true,
    version: CONFIG.version,
    config: CONFIG,
    state,
    get players() { return Array.from(state.players.values()); },
    get managers() { return Array.from(state.managers.values()); },
    get endpoints() { return state.endpoints; },
    rescan: scan,
    get history() { return history; },
    get requestBodies() { return state.requestBodies; },
    get replayHeaderNames() { return replayHeaders ? Object.keys(replayHeaders) : []; },
    diagnose() {
      const v = state.via;
      const r = {
        version: CONFIG.version,
        interceptores: { fetch: state.fetchOk, xhr: state.xhrOk },
        peticionesVistas: { fetchTotal: v.fetch, fetchAjax: v.ajaxFetch,
                            xhrTotal: v.xhr, xhrAjax: v.ajaxXhr },
        cabecerasAprendidas: replayHeaders ? Object.keys(replayHeaders) : [],
        payloadsVistos: Object.keys(state.requestBodies),
        respuestasProcesadas: state.endpoints.length
      };
      console.log("=== DIAGNÓSTICO MisterTools " + CONFIG.version + " ===");
      console.log(r);
      if (!v.ajaxFetch && !v.ajaxXhr) {
        console.warn("[MisterTools] No he visto NINGUNA petición a /ajax/. " +
          "O no has navegado desde que arrancó, o la web las envía por una vía " +
          "que no alcanzo.");
      }
      return r;
    },
    analyzeMarket,
    cancelAnalysis,
    get analysisState() {
      return { blocked: analysis.blocked, lastError: analysis.lastError,
               autoAnalyze: CONFIG.autoAnalyze, headers: replayHeaders ? Object.keys(replayHeaders) : [] };
    },
    exportData,
    uploadToGitHub,
    setGitHubToken: setToken,
    hasToken: () => !!getToken(),
    importData: importDataFromFile,
    loadRemoteData,
    loadExternalData,
    get external() { return state.external; },
    matchExternal,
    buildDataset,
    get clauses() { return state.clauses; },
    clausesByManager,
    unblockAnalysis() {
      analysis.blocked = false; analysis.errors = 0; analysis.attempted.clear();
      L("Análisis desbloqueado. Sigue desactivado el modo automático.");
    },
    clearHistory() { history = {}; try { localStorage.removeItem(HKEY); } catch (e) {} L('Histórico borrado'); },
    destroy,
    exportTechnicalSummary
  };

  init();
})();
