/* ===== YF7 Tournaments - frontend, talks to /api on the Python server ===== */

const API = "";  // same origin

async function api(path, opts = {}) {
  const o = { credentials: "include", headers: {}, ...opts };
  if (o.body && typeof o.body === "object" && !(o.body instanceof FormData)) {
    o.headers["Content-Type"] = "application/json";
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(API + path, o);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  if (r.status === 204) return null;
  const ct = r.headers.get("content-type") || "";
  return ct.includes("json") ? r.json() : r.text();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDate(d, withTime = false) {
  if (!d) return "-";
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  const opts = withTime
    ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(undefined, opts).format(dt);
}

const REGION_META = {
  emea: { label: "EMEA", asset: "/assets/emea.png" },
  northamerica: { label: "North America", asset: "/assets/na.png" },
  southamerica: { label: "South America", asset: "/assets/sa.png" },
  eastasia: { label: "East Asia", asset: "/assets/ea.png" },
};

function regionKey(region) {
  return String(region || "emea").toLowerCase().replace(/[^a-z]/g, "");
}

function regionMeta(region) {
  return REGION_META[regionKey(region)] || { label: region || "EMEA", asset: "" };
}

function regionLabel(region) {
  return regionMeta(region).label;
}

function regionBadge(region) {
  const meta = regionMeta(region);
  const icon = meta.asset ? `<img src="${esc(meta.asset)}" alt=""/>` : "";
  return `<span class="region-badge">${icon}${esc(meta.label)}</span>`;
}

// ===== NAVIGATION =====
function showPage(eventOrName, maybeName) {
  let event = null, name = maybeName;
  if (typeof eventOrName === "string") name = eventOrName;
  else event = eventOrName;
  if (event && event.preventDefault) event.preventDefault();

  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = document.getElementById(`page-${name}`);
  if (target) target.classList.add("active");

  document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
  if (event?.currentTarget?.classList) event.currentTarget.classList.add("active");
  else {
    const idx = ["home","esports","winning","news","contact","socials","about","admin"].indexOf(name);
    const links = document.querySelectorAll(".nav-link");
    if (idx >= 0 && links[idx]) links[idx].classList.add("active");
  }
  closeMenu();
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name !== "contact") stopTicketPolling();
  if (name !== "admin") stopAdminTicketPolling();

  // lazy-load some pages
  if (name === "esports") {
    loadLeaderboard(currentRegion, { showLoading: true });
    loadBracket(currentRegion, currentBracket, { showLoading: true });
    preloadEsports();
  }
  if (name === "winning") loadWinning();
  if (name === "news") loadNews();
  if (name === "about") loadAbout();
  if (name === "socials") loadTweets();
  if (name === "admin" && adminLoggedIn) loadAdminData();
}

// ===== TWEETS =====
// Server-side scraped via Nitter (see /api/tweets). We render our own dark
// cards - no Twitter widgets.js, no dependency on visitor login state.
let _tweetsLoaded = false;
async function loadTweets() {
  const box = document.getElementById("tweetsEmbed");
  if (!box || _tweetsLoaded) return;
  _tweetsLoaded = true;
  box.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;
  try {
    const data = await api("/api/tweets");
    renderTweets(box, data);
  } catch (e) {
    box.innerHTML = `
      <div class="tweets-fallback">
        <i class="fab fa-twitter"></i>
        <h4>Tweets unavailable right now</h4>
        <a class="btn btn-primary" href="https://x.com/YF7Tournaments"
           target="_blank" rel="noopener">
          <i class="fab fa-twitter"></i> View @YF7Tournaments on X
        </a>
      </div>`;
  }
}

function tweetRelTime(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60)    return "just now";
  if (sec < 3600)  return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h";
  if (sec < 604800) return Math.floor(sec / 86400) + "d";
  return d.toLocaleDateString();
}

function renderTweets(box, data) {
  const items = data.items || [];
  if (!items.length) {
    box.innerHTML = "";
    return;
  }
  const stale = data.stale ? `<div class="tweets-stale">Showing cached tweets while mirrors are slow.</div>` : "";
  const cards = items.slice(0, 8).map((t, index) => {
    // Route through our /api/img proxy to bypass X CDN referer issues.
    const proxify = u => `/api/img?url=${encodeURIComponent(u)}`;
    const imgs = (t.images || []).slice(0, 4)
      .map(u => `<img src="${esc(proxify(u))}" loading="lazy" onerror="this.parentElement.style.display='none'"/>`).join("");
    const body = esc(t.text).replace(/\n/g, "<br>")
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)@(\w+)/g, '$1<a href="https://x.com/$2" target="_blank" rel="noopener">@$2</a>')
      .replace(/(^|\s)#(\w+)/g, '$1<a href="https://x.com/hashtag/$2" target="_blank" rel="noopener">#$2</a>');
    const imgsClass = "tweet-images" + (imgs.split("<img").length - 1 === 1 ? " tweet-images-1" : "");
    return `
      <article class="tweet-card" data-tweet-index="${index}">
        <div class="tweet-header">
          <div class="tweet-avatar"><span>YF7</span></div>
          <div class="tweet-meta">
            <div class="tweet-name">YF7 Tournaments <i class="fas fa-check-circle tweet-verified"></i></div>
            <div class="tweet-handle">@YF7Tournaments · ${tweetRelTime(t.date)}</div>
          </div>
          <a class="tweet-link-out" href="${esc(t.link)}" target="_blank" rel="noopener" title="View on X">
            <i class="fab fa-twitter"></i>
          </a>
        </div>
        <div class="tweet-body">${body}</div>
        ${imgs ? `<div class="${imgsClass}">${imgs}</div>` : ""}
        <div class="tweet-actions">
          <a href="${esc(t.link)}" target="_blank" rel="noopener" class="tweet-action">
            <i class="far fa-comment"></i>
          </a>
          <a href="${esc(t.link)}" target="_blank" rel="noopener" class="tweet-action">
            <i class="fas fa-retweet"></i>
          </a>
          <a href="${esc(t.link)}" target="_blank" rel="noopener" class="tweet-action">
            <i class="far fa-heart"></i>
          </a>
          <a href="${esc(t.link)}" target="_blank" rel="noopener" class="tweet-action tweet-view-on-x">
            View on X <i class="fas fa-external-link-alt"></i>
          </a>
        </div>
      </article>`;
  });

  const columns = [[], []];
  cards.forEach((card, index) => columns[index % 2].push(card));
  const secondColumn = columns[1].length
    ? `<div class="tweet-column">${columns[1].join("")}</div>`
    : "";

  box.innerHTML = `${stale}
    <div class="tweets-masonry${secondColumn ? "" : " single"}">
      <div class="tweet-column">${columns[0].join("")}</div>
      ${secondColumn}
    </div>`;

  if (secondColumn) {
    let balanceFrame = 0;
    const balanceColumns = () => {
      cancelAnimationFrame(balanceFrame);
      balanceFrame = requestAnimationFrame(() => {
        const columnElements = [...box.querySelectorAll(".tweet-column")];
        const cardElements = [...box.querySelectorAll(".tweet-card")]
          .sort((a, b) => Number(a.dataset.tweetIndex) - Number(b.dataset.tweetIndex));
        if (columnElements.length !== 2 || cardElements.length < 2) return;

        const heights = cardElements.map(card => card.getBoundingClientRect().height);
        columnElements.forEach(column => column.replaceChildren());
        const totals = [0, 0];
        cardElements.forEach((card, index) => {
          const target = totals[0] <= totals[1] ? 0 : 1;
          columnElements[target].append(card);
          totals[target] += heights[index] + 14;
        });
      });
    };

    balanceColumns();
    box.querySelectorAll(".tweet-images img").forEach(img => {
      if (!img.complete) {
        img.addEventListener("load", balanceColumns, { once: true });
        img.addEventListener("error", balanceColumns, { once: true });
      }
    });
  }
}

function toggleMenu() { document.getElementById("navLinks").classList.toggle("open"); }
function closeMenu() { document.getElementById("navLinks").classList.remove("open"); }

function scrollToTournaments() {
  const home = document.getElementById("page-home");
  if (!home?.classList.contains("active")) showPage("home");
  requestAnimationFrame(() => {
    document.getElementById("tournaments")?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  });
}

window.addEventListener("scroll", () => {
  const n = document.getElementById("navbar");
  if (n) n.classList.toggle("scrolled", window.scrollY > 50);
});

// ===== TOURNAMENTS =====
let allTournaments = [];
let tournamentFilter = "all";
const TOURNAMENT_REFRESH_INTERVAL = 60 * 60 * 1000;

async function loadTournaments() {
  try {
    allTournaments = await api("/api/tournaments");
    renderTournaments();
  } catch (e) {
    document.getElementById("tournamentsGrid").innerHTML =
      `<p class="empty">Could not load tournaments: ${esc(e.message)}</p>`;
  }
}

function renderTournaments() {
  const grid = document.getElementById("tournamentsGrid");
  if (!grid) return;
  const list = tournamentFilter === "all"
    ? allTournaments
    : allTournaments.filter(t => (t.computed_status || "upcoming") === tournamentFilter);

  if (!list.length) {
    grid.innerHTML = `<p class="empty">No tournaments to show here yet.</p>`;
    return;
  }
  grid.innerHTML = list.map(t => {
    const status = t.computed_status || "upcoming";
    const label = { upcoming: "Upcoming", live: "Live now", past: "Finished" }[status];
    const banner = t.image
      ? `<img class="tournament-banner" src="${esc(t.image)}" alt=""/>`
      : `<div class="tournament-banner-placeholder"><span>YF7</span></div>`;
    const href = t.link || "#";
    return `
      <a class="tournament-card" href="${esc(href)}" target="_blank" rel="noopener">
        ${banner}
        <div class="tournament-info">
          <span class="tournament-status status-${status}">${label}</span>
          <h3>${esc(t.name)}</h3>
          <div class="tournament-meta">
            <span><i class="fas fa-calendar"></i> ${fmtDate(t.date, true)}</span>
            ${regionBadge(t.region)}
            <span class="prize"><i class="fas fa-trophy"></i> ${esc(t.prize || "-")}</span>
          </div>
        </div>
      </a>`;
  }).join("");
}

function filterTournaments(ev, kind) {
  tournamentFilter = kind;
  document.querySelectorAll(".filter-pill").forEach(b => b.classList.remove("active"));
  ev.currentTarget.classList.add("active");
  renderTournaments();
}

setInterval(loadTournaments, TOURNAMENT_REFRESH_INTERVAL);

// ===== ESPORTS =====
let currentRegion = "emea";
let currentBracketRegion = "emea";
let currentBracket = "q1";
let currentBracketMonth = "";
let bracketMonthsLoaded = false;
const ESPORTS_REGIONS = ["emea", "northamerica", "southamerica", "eastasia"];
const BRACKET_TYPES = ["q1", "q2", "mf"];
const leaderboardCache = new Map();
const leaderboardRequests = new Map();
const bracketCache = new Map();
const bracketRequests = new Map();

function warmImages(urls) {
  urls.filter(Boolean).forEach(url => {
    const image = new Image();
    image.src = url;
  });
}

function showRegion(ev, region) {
  currentRegion = region;
  currentBracketRegion = region;
  document.querySelectorAll(".regions-tabs .tab-btn").forEach(b => b.classList.remove("active"));
  ev.currentTarget.classList.add("active");
  document.getElementById("currentRegion").textContent = regionLabel(region);
  const sel = document.getElementById("bracketRegion");
  if (sel) sel.value = region;
  loadLeaderboard(region);
  loadBracket(currentBracketRegion, currentBracket);
}

function onBracketRegionChange() {
  const sel = document.getElementById("bracketRegion");
  if (!sel) return;
  currentBracketRegion = sel.value;
  loadBracket(currentBracketRegion, currentBracket, { showLoading: true });
}

function fetchLeaderboard(region) {
  if (leaderboardCache.has(region)) return Promise.resolve(leaderboardCache.get(region));
  if (leaderboardRequests.has(region)) return leaderboardRequests.get(region);

  const request = api(`/api/leaderboard/${region}`)
    .then(data => {
      leaderboardCache.set(region, data);
      warmImages((data.items || []).map(item => item.logo));
      return data;
    })
    .finally(() => leaderboardRequests.delete(region));
  leaderboardRequests.set(region, request);
  return request;
}

function renderLeaderboard(data) {
  const table = document.getElementById("leaderboardTable");
  const rows = (data.items || []).slice(0, 10);
  // After every leaderboard re-render the standings box may resize.
  queueMicrotask(() => { if (typeof syncBracketHeight === "function") syncBracketHeight(); });
  if (!rows.length) {
    table.innerHTML = `<p class="empty">No standings available for this region yet.</p>`;
    return;
  }
  const stale = data.stale ? `<div class="lb-stale">Showing cached standings while Supercell is unreachable.</div>` : "";
  table.innerHTML = stale + rows.map((p, i) => {
    const trophyIcon =
      p.trophy === "gold"   ? `<i class="fas fa-trophy" style="color:#FFD700"></i>` :
      p.trophy === "silver" ? `<i class="fas fa-trophy" style="color:#C0C0C0"></i>` : "";
    const cls = "lb-row" + (p.disabled ? " lb-row-disabled" : "")
                         + (p.trophy === "gold" ? " lb-gold" : "")
                         + (p.trophy === "silver" ? " lb-silver" : "");
    const logo = p.logo
      ? `<img class="lb-logo" src="${esc(p.logo)}" alt="" onerror="this.style.visibility='hidden'"/>`
      : `<div class="lb-logo lb-logo-placeholder"></div>`;
    return `
      <div class="${cls}">
        <div class="lb-rank">${i + 1}</div>
        ${logo}
        <div class="lb-name">${esc(p.name)}<span class="lb-region-tag">${esc(p.region || "")}</span></div>
        <div class="lb-trophy">${trophyIcon}</div>
        <div class="lb-points">${p.points}</div>
      </div>`;
  }).join("");
}

async function loadLeaderboard(region, { showLoading = false } = {}) {
  const table = document.getElementById("leaderboardTable");
  if (leaderboardCache.has(region)) {
    renderLeaderboard(leaderboardCache.get(region));
    return;
  }
  if (showLoading && !table.children.length) {
    table.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;
  }
  try {
    const data = await fetchLeaderboard(region);
    if (currentRegion === region) renderLeaderboard(data);
  } catch (e) {
    if (currentRegion === region) {
      table.innerHTML = `<p class="empty">Error loading standings: ${esc(e.message)}</p>`;
    }
  }
}

function showBracket(ev, type) {
  currentBracket = type;
  document.querySelectorAll(".brackets-tabs .bracket-tab").forEach(b => b.classList.remove("active"));
  ev.currentTarget.classList.add("active");
  loadBracket(currentBracketRegion, type);
}

function bracketKey(region, type, month) {
  return `${region}:${type}:${month || ""}`;
}

function fetchBracket(region, type, month, { force = false } = {}) {
  const key = bracketKey(region, type, month);
  if (!force && bracketRequests.has(key)) return bracketRequests.get(key);

  const url = month
    ? `/api/live-brackets/${region}/${type}?month=${encodeURIComponent(month)}`
    : `/api/live-brackets/${region}/${type}`;
  const request = api(url)
    .then(data => {
      bracketCache.set(key, data);
      return data;
    })
    .finally(() => bracketRequests.delete(key));
  if (!force) bracketRequests.set(key, request);
  return request;
}

function bracketTypeLabel(type) {
  return type === "q1" ? "Qualifier 1"
       : type === "q2" ? "Qualifier 2"
       : type === "mf" ? "Monthly Finals"
       : type.toUpperCase();
}

function monthLabel(yyyymm) {
  if (!yyyymm) return "";
  const [y, m] = yyyymm.split("-");
  const names = ["January","February","March","April","May","June",
                 "July","August","September","October","November","December"];
  const idx = parseInt(m, 10) - 1;
  return (names[idx] || m) + " " + y;
}

async function ensureBracketMonths() {
  if (bracketMonthsLoaded) return;
  bracketMonthsLoaded = true;
  const sel = document.getElementById("bracketMonth");
  if (!sel) return;
  try {
    const months = await api("/api/live-brackets/months");
    if (!Array.isArray(months) || !months.length) {
      sel.innerHTML = `<option value="">Latest</option>`;
      return;
    }
    sel.innerHTML = months.map(m =>
      `<option value="${esc(m)}">${esc(monthLabel(m))}</option>`
    ).join("");
    currentBracketMonth = months[0];
    sel.value = currentBracketMonth;
  } catch (_e) {
    sel.innerHTML = `<option value="">Latest</option>`;
  }
}

function onBracketMonthChange() {
  const sel = document.getElementById("bracketMonth");
  currentBracketMonth = sel ? sel.value : "";
  loadBracket(currentBracketRegion, currentBracket, { showLoading: true });
}

function setBracketFullscreen(on) {
  const frame = document.getElementById("bracketFrame");
  if (!frame) return;
  const isOn = frame.classList.contains("bracket-fullscreen");
  if (on === isOn) return;
  frame.classList.toggle("bracket-fullscreen", on);
  document.body.classList.toggle("bracket-fs-lock", on);
  const icon = document.querySelector(".bracket-fs-btn i");
  if (icon) {
    icon.classList.toggle("fa-expand",  !on);
    icon.classList.toggle("fa-compress", on);
  }
  // Floating exit button only present while fullscreen
  let exitBtn = document.getElementById("bracketFsExit");
  if (on && !exitBtn) {
    exitBtn = document.createElement("button");
    exitBtn.id = "bracketFsExit";
    exitBtn.className = "bracket-fs-exit";
    exitBtn.type = "button";
    exitBtn.title = "Exit fullscreen (Esc)";
    exitBtn.innerHTML = `<i class="fas fa-times"></i>`;
    exitBtn.onclick = () => setBracketFullscreen(false);
    frame.appendChild(exitBtn);
  } else if (!on && exitBtn) {
    exitBtn.remove();
  }
  if (typeof syncBracketHeight === "function") syncBracketHeight();
  scheduleBracketConnectors();
}

function toggleBracketFullscreen() {
  const frame = document.getElementById("bracketFrame");
  if (!frame) return;
  setBracketFullscreen(!frame.classList.contains("bracket-fullscreen"));
}

/* Sync the bracket frame's height with the standings box next to it, so the
   two columns are visually identical in height regardless of bracket content.
   In fullscreen mode the height override is cleared. */
function syncBracketHeight() {
  const frame = document.getElementById("bracketFrame");
  const lb    = document.querySelector(".leaderboard-container");
  const bc    = document.querySelector(".brackets-container");
  if (!frame || !lb || !bc) return;
  if (frame.classList.contains("bracket-fullscreen")) {
    frame.style.height = "";
    return;
  }
  // Stacked single-column layout on mobile — let CSS handle the height.
  if (window.matchMedia("(max-width: 900px)").matches) {
    frame.style.height = "";
    return;
  }
  const lbHeight = lb.getBoundingClientRect().height;
  // height available for the frame = standings height − everything above it
  // inside the brackets container.
  let usedAbove = 0;
  for (const child of bc.children) {
    if (child === frame) break;
    usedAbove += child.getBoundingClientRect().height;
  }
  const cs = getComputedStyle(bc);
  const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const target = Math.max(160, lbHeight - usedAbove - padV);
  frame.style.height = target + "px";
  scheduleBracketConnectors();
}

let _bracketSyncBound = false;
function bindBracketHeightSync() {
  if (_bracketSyncBound) return;
  _bracketSyncBound = true;
  const lb = document.querySelector(".leaderboard-container");
  if (!lb) return;
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      syncBracketHeight();
      scheduleBracketConnectors();
    }).observe(lb);
  }
  window.addEventListener("resize", () => {
    syncBracketHeight();
    scheduleBracketConnectors();
  });
  // Initial pass + a delayed retry to catch async content (logos / fonts).
  syncBracketHeight();
  setTimeout(syncBracketHeight, 250);
  setTimeout(syncBracketHeight, 1200);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const frame = document.getElementById("bracketFrame");
    if (frame && frame.classList.contains("bracket-fullscreen")) {
      setBracketFullscreen(false);
    }
  }
});

function competitorHtml(c) {
  if (!c || c.isBye || !c.roster || !c.roster.name) {
    return `<div class="bm-side bm-bye"><span class="bm-name">BYE</span></div>`;
  }
  const name  = esc(c.roster.name);
  const score = (c.result && c.result.score != null) ? c.result.score : "";
  const won   = c.placement === 1;
  const seed  = (c.seed && c.seed.number != null) ? c.seed.number : "";
  return `
    <div class="bm-side ${won ? "bm-winner" : ""}">
      ${seed !== "" ? `<span class="bm-seed">${seed}</span>` : ""}
      <span class="bm-name">${name}</span>
      <span class="bm-score">${score}</span>
    </div>`;
}

let bracketConnectorFrame = 0;

function scheduleBracketConnectors() {
  cancelAnimationFrame(bracketConnectorFrame);
  bracketConnectorFrame = requestAnimationFrame(() => {
    drawBracketConnectors();
    setTimeout(drawBracketConnectors, 80);
  });
}

function drawBracketConnectors() {
  const grid = document.querySelector("#bracketDisplay .bm-grid");
  if (!grid) return;

  grid.querySelector(".bm-connectors")?.remove();
  const rounds = [...grid.querySelectorAll(".bm-round")];
  if (rounds.length < 2) return;

  const gridRect = grid.getBoundingClientRect();
  const width = Math.max(grid.scrollWidth, Math.ceil(gridRect.width));
  const height = Math.max(grid.scrollHeight, Math.ceil(gridRect.height));
  const paths = [];

  for (let ri = 0; ri < rounds.length - 1; ri++) {
    const sourceBox = rounds[ri].querySelector(".bm-round-matches");
    const targetBox = rounds[ri + 1].querySelector(".bm-round-matches");
    if (!sourceBox || !targetBox) continue;

    const sources = [...sourceBox.querySelectorAll(".bm-match")];
    const targets = [...targetBox.querySelectorAll(".bm-match")];

    targets.forEach((target, ti) => {
      const pair = sources.slice(ti * 2, ti * 2 + 2);
      if (!pair.length) return;

      const targetRect = target.getBoundingClientRect();
      const targetX = targetRect.left - gridRect.left;
      const targetY = targetRect.top - gridRect.top + targetRect.height / 2;
      const sourcePoints = pair.map(source => {
        const rect = source.getBoundingClientRect();
        return {
          x: rect.right - gridRect.left,
          y: rect.top - gridRect.top + rect.height / 2,
        };
      });
      const sourceX = Math.max(...sourcePoints.map(point => point.x));
      const middleX = sourceX + Math.max(8, (targetX - sourceX) / 2);

      sourcePoints.forEach(point => {
        paths.push(`M ${point.x} ${point.y} H ${middleX}`);
      });
      const connectorYs = [...sourcePoints.map(point => point.y), targetY];
      const topY = Math.min(...connectorYs);
      const bottomY = Math.max(...connectorYs);
      if (bottomY > topY) {
        paths.push(`M ${middleX} ${topY} V ${bottomY}`);
      }
      paths.push(`M ${middleX} ${targetY} H ${targetX}`);
    });
  }

  if (!paths.length) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("bm-connectors");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths.join(" "));
  svg.appendChild(path);
  grid.prepend(svg);
}

function renderBracket(data, region, type) {
  const box = document.getElementById("bracketDisplay");
  const matches = (data && data.matches) || [];
  if (!matches.length) {
    box.innerHTML = `
      <div class="bracket-placeholder">
        <i class="fas fa-sitemap"></i>
        <p>No ${esc(bracketTypeLabel(type))} bracket for ${esc(regionLabel(region))}${currentBracketMonth ? " — " + esc(monthLabel(currentBracketMonth)) : ""}</p>
      </div>`;
    return;
  }

  // Group by round, sort by matchNumber
  const rounds = new Map();
  for (const m of matches) {
    const r = m.roundNumber || 0;
    if (!rounds.has(r)) rounds.set(r, []);
    rounds.get(r).push(m);
  }
  const roundKeys = [...rounds.keys()].sort((a, b) => a - b);
  for (const k of roundKeys) {
    rounds.get(k).sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0));
  }

  const matchHtml = (m) => {
    const cs = m.competitors || [];
    const top = cs.find(c => c.number === 1) || cs[0];
    const bot = cs.find(c => c.number === 2) || cs[1];
    return `
      <div class="bm-match" data-state="${esc(m.state || "")}">
        ${competitorHtml(top)}
        ${competitorHtml(bot)}
      </div>`;
  };

  const cols = roundKeys.map((r, ri) => {
    const ms = rounds.get(r);
    const isLast = ri === roundKeys.length - 1;
    let body;
    if (isLast || ms.length < 2) {
      body = ms.map(matchHtml).join("");
    } else {
      // Wrap consecutive pairs so CSS can draw bracket connectors per pair
      const pairs = [];
      for (let i = 0; i < ms.length; i += 2) {
        pairs.push(ms.slice(i, i + 2));
      }
      body = pairs.map(p =>
        `<div class="bm-pair">${p.map(matchHtml).join("")}</div>`
      ).join("");
    }
    return `
      <div class="bm-round">
        <div class="bm-round-title">Round ${r}</div>
        <div class="bm-round-matches">${body}</div>
      </div>`;
  }).join("");

  box.innerHTML = `<div class="bm-grid">${cols}</div>`;
  scheduleBracketConnectors();
}

async function loadBracket(region, type, { showLoading = false } = {}) {
  await ensureBracketMonths();
  const month = currentBracketMonth;
  const box = document.getElementById("bracketDisplay");
  const key = bracketKey(region, type, month);
  if (bracketCache.has(key)) {
    renderBracket(bracketCache.get(key), region, type);
  } else if (showLoading) {
    box.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;
  }
  try {
    const data = await fetchBracket(region, type, month);
    if (currentBracketRegion === region && currentBracket === type && currentBracketMonth === month) {
      renderBracket(data, region, type);
    }
  } catch (e) {
    if (currentBracketRegion === region && currentBracket === type && !bracketCache.has(key)) {
      box.innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
    }
  }
}

let esportsPreloadStarted = false;
function preloadEsports() {
  if (esportsPreloadStarted) return;
  esportsPreloadStarted = true;
  ESPORTS_REGIONS.forEach(region => {
    fetchLeaderboard(region).catch(() => {});
    BRACKET_TYPES.forEach(type => fetchBracket(region, type).catch(() => {}));
  });
  bindBracketHeightSync();
  startBracketLivePoll();
}

/* Live refresh: re-fetch the currently-visible bracket every 20s, bypassing
   the in-memory cache. Skips polling when the esports page isn't active or
   when the tab is hidden, to avoid wasted requests. */
const BRACKET_LIVE_INTERVAL_MS = 20000;
let bracketLiveTimer = null;
function startBracketLivePoll() {
  if (bracketLiveTimer) return;
  bracketLiveTimer = setInterval(refreshLiveBracket, BRACKET_LIVE_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshLiveBracket();
  });
}
async function refreshLiveBracket() {
  if (document.hidden) return;
  const esports = document.getElementById("page-esports");
  if (!esports || !esports.classList.contains("active")) return;
  const region = currentBracketRegion;
  const type   = currentBracket;
  const month  = currentBracketMonth;
  try {
    const data = await fetchBracket(region, type, month, { force: true });
    if (currentBracketRegion === region && currentBracket === type && currentBracketMonth === month) {
      renderBracket(data, region, type);
    }
  } catch (_e) { /* keep last good render */ }
}

async function loadWinning() {
  const grid = document.getElementById("winningGrid");
  grid.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;
  try {
    const all = (await api("/api/winning")).filter(p => p.type === "team");
    if (!all.length) {
      grid.innerHTML = `<p class="empty">No winning team screenshots posted yet.</p>`;
      return;
    }
    grid.innerHTML = all.map(p => {
      const matcherinoId = /^\d+$/.test(String(p.matcherino_id || ""))
        ? String(p.matcherino_id)
        : "";
      const image = p.avatar
        ? `<img src="${esc(p.avatar)}" alt="${esc(p.name)}" loading="lazy"${matcherinoId ? "" : ` onclick="openLightbox('${esc(p.avatar)}')"`}/>`
        : `<div class="winning-screen-placeholder"><span>YF7</span></div>`;
      const media = matcherinoId
        ? `<a class="winning-screen-link" href="https://matcherino.com/tournaments/${matcherinoId}" aria-label="Open ${esc(p.name || "tournament")} on Matcherino">${image}</a>`
        : image;
      return `
        <div class="winning-screen-card">
          ${media}
        </div>`;
    }).join("");
  } catch (e) {
    grid.innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
  }
}

function openLightbox(url) {
  let lb = document.getElementById("winnerLightbox");
  if (!lb) {
    lb = document.createElement("div");
    lb.id = "winnerLightbox";
    lb.className = "winner-lightbox";
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
  }
  lb.innerHTML = `<img src="${url}"/>`;
}

// ===== NEWS =====
async function loadNews() {
  const grid = document.getElementById("newsGrid");
  grid.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;
  try {
    const items = await api("/api/news");
    if (!items.length) {
      grid.innerHTML = `<p class="empty">No articles yet. Check back soon!</p>`;
      return;
    }
    grid.innerHTML = items.map(a => {
      const img = a.image
        ? `<img class="news-img" src="${esc(a.image)}" alt=""/>`
        : `<div class="news-img-placeholder"><span>YF7</span></div>`;
      return `
        <div class="news-card" onclick='openNewsModal(${JSON.stringify(a).replace(/'/g,"&#39;")})'>
          ${img}
          <div class="news-content">
            <span class="news-category">${esc(a.category || "News")}</span>
            <h3>${esc(a.title)}</h3>
            <p>${esc(a.content || "")}</p>
            <div class="news-date"><i class="fas fa-clock"></i> ${fmtDate(a.date)}</div>
          </div>
        </div>`;
    }).join("");
  } catch (e) {
    grid.innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
  }
}

function openNewsModal(a) {
  const body = (a.content || "")
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${esc(p)}</p>`)
    .join("");
  document.getElementById("newsModalContent").innerHTML = `
    ${a.image ? `
      <div class="news-article-media">
        <img src="${esc(a.image)}" alt="${esc(a.title)}"/>
      </div>` : ""}
    <article class="news-article">
      <header class="news-article-header">
        <span class="news-category">${esc(a.category || "News")}</span>
        <h2>${esc(a.title)}</h2>
        <div class="news-article-meta">
          <span><i class="fas fa-calendar"></i> ${fmtDate(a.date)}</span>
          <span><i class="fas fa-newspaper"></i> YF7 Tournaments</span>
        </div>
      </header>
      <div class="news-article-body">${body || "<p>No article content has been published yet.</p>"}</div>
    </article>`;
  document.getElementById("newsModal").classList.add("open");
}
function closeModal(id) { document.getElementById(id).classList.remove("open"); }

// ===== CONTACT =====
let currentTicketCode = null;
let ticketPollTimer = null;
let ticketRefreshPending = false;
let currentTicketSnapshot = "";

function showContactTab(ev, tab) {
  document.querySelectorAll(".contact-tab-content").forEach(t => t.classList.remove("active"));
  document.getElementById("contact-" + tab).classList.add("active");
  document.querySelectorAll(".contact-tabs .tab-btn").forEach(b => b.classList.remove("active"));
  if (ev?.currentTarget) ev.currentTarget.classList.add("active");
  if (tab === "check" && currentTicketCode) startTicketPolling();
  else stopTicketPolling();
}

async function submitContact(ev) {
  ev.preventDefault();
  const body = {
    name: document.getElementById("contactName").value.trim(),
    discord: document.getElementById("contactDiscordHandle").value.trim(),
    subject: document.getElementById("contactSubject").value,
    message: document.getElementById("contactMessage").value.trim(),
  };
  try {
    const r = await api("/api/tickets", { method: "POST", body });
    currentTicketCode = r.code;
    document.querySelector("#contactForm button[type=submit]").style.display = "none";
    document.getElementById("contactSuccess").style.display = "block";
    document.getElementById("ticketCodeDisplay").textContent = r.code;
    ["contactName","contactDiscordHandle","contactMessage"].forEach(id => document.getElementById(id).value = "");
  } catch (e) {
    alert("Could not submit: " + e.message);
  }
}

async function copyTicketCode() {
  const code = (document.getElementById("ticketCodeDisplay").textContent || currentTicketCode || "").trim();
  if (!code) return;

  try {
    await copyText(code);
    alert("Code copied: " + code);
  } catch (_) {
    window.prompt("Copy your ticket code:", code);
  }
}

async function copyText(value) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  field.style.pointerEvents = "none";
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, field.value.length);
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("copy failed");
}

async function copyStaffDiscord(handle) {
  try {
    await copyText(handle);
    alert("Discord username copied: " + handle);
  } catch (_) {
    window.prompt("Copy Discord username:", handle);
  }
}

async function searchTicket() {
  const code = document.getElementById("ticketSearchInput").value.trim().toUpperCase();
  stopTicketPolling();
  document.getElementById("ticketNotFound").style.display = "none";
  document.getElementById("ticketChatBox").style.display = "none";
  try {
    const ticket = await api(`/api/tickets/${encodeURIComponent(code)}`, { cache: "no-store" });
    currentTicketCode = code;
    renderUserTicket(ticket);
    startTicketPolling();
  } catch (_) {
    currentTicketCode = null;
    currentTicketSnapshot = "";
    document.getElementById("ticketNotFound").style.display = "block";
  }
}

function ticketSnapshot(t) {
  return JSON.stringify({
    status: t.status,
    subject: t.subject,
    messages: t.messages || []
  });
}

function renderUserTicket(t, { preserveScroll = false } = {}) {
  currentTicketSnapshot = ticketSnapshot(t);
  document.getElementById("tcCode").textContent = t.code;
  document.getElementById("tcSubject").textContent = t.subject;
  const badge = document.getElementById("tcStatus");
  badge.textContent = t.status === "open" ? "Open" : "Closed";
  badge.className = "ticket-status-badge " + t.status;
  const box = document.getElementById("tcMessages");
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  const previousScroll = box.scrollTop;
  box.innerHTML = t.messages.map(m => `
    <div class="chat-message ${m.author}">
      <div class="chat-bubble">
        <div class="chat-meta">
          <strong>${m.author === "admin" ? "YF7 Staff" : esc(m.authorName || "User")}</strong>
          <span>${fmtDate(m.date, true)}</span>
        </div>
        <p>${esc(m.text)}</p>
      </div>
    </div>`).join("");
  if (!preserveScroll || wasNearBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = previousScroll;
  document.getElementById("ticketChatBox").style.display = "block";
  document.getElementById("tcReplyArea").style.display = t.status === "open" ? "flex" : "none";
}

async function refreshUserTicket() {
  const chat = document.getElementById("ticketChatBox");
  const checkTab = document.getElementById("contact-check");
  if (!currentTicketCode || ticketRefreshPending || document.hidden ||
      !chat || chat.style.display === "none" || !checkTab?.classList.contains("active")) return;

  ticketRefreshPending = true;
  try {
    const ticket = await api(`/api/tickets/${encodeURIComponent(currentTicketCode)}`, {
      cache: "no-store"
    });
    if (ticketSnapshot(ticket) !== currentTicketSnapshot) {
      renderUserTicket(ticket, { preserveScroll: true });
    }
  } catch (_) {
    // A temporary network failure should not replace the open conversation.
  } finally {
    ticketRefreshPending = false;
  }
}

function startTicketPolling() {
  stopTicketPolling();
  if (!currentTicketCode) return;
  ticketPollTimer = window.setInterval(refreshUserTicket, 3000);
}

function stopTicketPolling() {
  if (ticketPollTimer) window.clearInterval(ticketPollTimer);
  ticketPollTimer = null;
  ticketRefreshPending = false;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && ticketPollTimer) refreshUserTicket();
  if (!document.hidden && adminTicketPollTimer) refreshAdminTickets();
});

async function sendUserReply() {
  const input = document.getElementById("tcReplyInput");
  const text = input.value.trim();
  if (!text || !currentTicketCode) return;
  try {
    const t = await api(`/api/tickets/${encodeURIComponent(currentTicketCode)}/reply`,
      { method: "POST", body: { text } });
    input.value = "";
    renderUserTicket(t);
    startTicketPolling();
  } catch (e) { alert(e.message); }
}

// ===== ABOUT =====
async function loadAbout() {
  try {
    const a = await api("/api/about");
    document.getElementById("aboutDescription").innerHTML =
      `<p>${esc(a.description).replace(/\n/g, "<br>")}</p>`;
    if (a.discord) wireDiscordLinks(a.discord);

    const staff = document.getElementById("staffGrid");
    if (!a.staff.length) {
      staff.innerHTML = `<p class="empty">Staff coming soon.</p>`;
    } else {
      staff.innerHTML = a.staff.map(m => {
        const discord = String(m.discord || "").trim();
        const xValue = String(m.x_url || "").trim();
        const discordIsUrl = /^https?:\/\//i.test(discord);
        const xHref = xValue
          ? (/^https?:\/\//i.test(xValue)
              ? xValue
              : `https://x.com/${xValue.replace(/^@/, "")}`)
          : "";
        const socials = [
          discord
            ? (discordIsUrl
                ? `<a href="${esc(discord)}" target="_blank" rel="noopener" class="staff-social" title="Discord">
                     <i class="fab fa-discord"></i><span>Discord</span>
                   </a>`
                : `<button type="button" class="staff-social staff-social-handle"
                     data-handle="${esc(discord)}" onclick="copyStaffDiscord(this.dataset.handle)"
                     title="Copy Discord username">
                     <i class="fab fa-discord"></i><span>${esc(discord)}</span>
                   </button>`)
            : "",
          xHref
            ? `<a href="${esc(xHref)}" target="_blank" rel="noopener" class="staff-social" title="X profile">
                 <i class="fab fa-x-twitter"></i><span>X</span>
               </a>`
            : ""
        ].filter(Boolean).join("");

        return `
          <article class="staff-card">
            <div class="staff-profile">
              ${m.pfp
                ? `<img src="${esc(m.pfp)}" alt="${esc(m.name)}" class="staff-pfp"/>`
                : `<div class="staff-pfp staff-pfp-placeholder">${esc((m.name || "YF7").slice(0, 2).toUpperCase())}</div>`}
              <div class="staff-identity">
                <h4>${esc(m.name)}</h4>
                <div class="staff-role">${esc(m.role || "Staff")}</div>
              </div>
            </div>
            ${m.description ? `<p class="staff-desc">${esc(m.description)}</p>` : ""}
            ${socials ? `<div class="staff-socials">${socials}</div>` : ""}
          </article>`;
      }).join("");
    }
    const partners = document.getElementById("partnersGrid");
    if (!a.partners.length) {
      partners.innerHTML = `<p class="empty">Become our first partner - contact us.</p>`;
    } else {
      // Marquee: duplicate the list enough times to fill the viewport so the
      // scroll loops seamlessly even with very few partners.
      const card = p => `
        <a class="partner-card" href="${esc(p.url || "#")}" target="_blank" rel="noopener">
          ${p.logo ? `<img class="partner-logo" src="${esc(p.logo)}"/>` : ""}
          <span class="partner-name">${esc(p.name)}</span>
        </a>`;
      const reps = Math.max(4, Math.ceil(8 / a.partners.length));
      const items = Array(reps).fill(a.partners).flat().map(card).join("");
      partners.innerHTML = `
        <div class="partners-marquee">
          <div class="partners-track">${items}</div>
        </div>`;
    }
  } catch (e) {
    document.getElementById("aboutDescription").innerHTML = `<p>${esc(e.message)}</p>`;
  }
}

function wireDiscordLinks(url) {
  ["heroDiscord","contactDiscord","socialsDiscord","footerDiscord"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.href = url;
  });
}

// ===== ADMIN =====
let adminLoggedIn = false;

async function checkAdminSession() {
  try {
    const r = await api("/api/admin/me");
    adminLoggedIn = r.admin;
    if (adminLoggedIn) {
      document.getElementById("adminLogin").style.display = "none";
      document.getElementById("adminPanel").style.display = "block";
      loadAdminData();
    }
  } catch (_) {}
}

async function adminLogin(ev) {
  ev.preventDefault();
  const body = {
    email: document.getElementById("adminEmail").value,
    password: document.getElementById("adminPassword").value,
  };
  try {
    await api("/api/admin/login", { method: "POST", body });
    adminLoggedIn = true;
    document.getElementById("adminLogin").style.display = "none";
    document.getElementById("adminPanel").style.display = "block";
    loadAdminData();
  } catch (_) {
    const err = document.getElementById("loginError");
    err.style.display = "block";
    setTimeout(() => err.style.display = "none", 3000);
  }
}

async function adminLogout() {
  stopAdminTicketPolling();
  await api("/api/admin/logout", { method: "POST" });
  adminLoggedIn = false;
  location.reload();
}

function showAdminTab(ev, tab) {
  document.querySelectorAll(".admin-tab-content").forEach(t => t.classList.remove("active"));
  document.getElementById(`admin-${tab}`).classList.add("active");
  document.querySelectorAll(".admin-tabs .tab-btn").forEach(b => b.classList.remove("active"));
  ev.currentTarget.classList.add("active");
  if (tab === "messages") {
    loadAdminTickets();
    startAdminTicketPolling();
  } else {
    stopAdminTicketPolling();
  }
}

function loadAdminData() {
  loadAdminTournaments();
  loadAdminNews();
  loadAdminWinning();
  loadAdminAbout();
  loadAdminStaff();
  loadAdminPartners();
  loadAdminTickets();
  wireFileUploads();
}

// --- image upload helper ---
function wireFileUploads() {
  const pairs = [
    ["nImageFile","nImage","nImagePreview"],
    ["wAvatarFile","wAvatar","wAvatarPreview"],
    ["sPfpFile","sPfp","sPfpPreview"],
    ["pLogoFile","pLogo","pLogoPreview"],
  ];
  pairs.forEach(([f, h, prev]) => {
    const el = document.getElementById(f);
    if (!el || el._wired) return;
    el._wired = true;
    el.addEventListener("change", async () => {
      const file = el.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append("file", file);
      try {
        const r = await api("/api/upload", { method: "POST", body: fd });
        document.getElementById(h).value = r.url;
        document.getElementById(prev).innerHTML = `<img src="${r.url}"/>`;
      } catch (e) { alert("Upload failed: " + e.message); }
    });
  });
}

// --- Matcherino quick-add ---
async function previewMatcherino() {
  const id = document.getElementById("mId").value.trim();
  const errEl = document.getElementById("mError");
  const prev = document.getElementById("mPreview");
  errEl.style.display = "none"; prev.style.display = "none";
  if (!/^\d+$/.test(id)) { errEl.textContent = "Enter a numeric Matcherino ID."; errEl.style.display = "block"; return; }
  try {
    const info = await api(`/api/matcherino/${id}`);
    prev.innerHTML = `
      ${info.image ? `<img src="${esc(info.image)}" alt=""/>` : ""}
      <div class="mp-body">
        <h4>${esc(info.name)}</h4>
        <p><i class="fas fa-calendar"></i> ${fmtDate(info.date, true)}</p>
        <p><i class="fas fa-trophy yellow"></i> ${esc(info.prize || "-")}</p>
        <p><a href="${esc(info.link)}" target="_blank" rel="noopener">
          <i class="fas fa-external-link-alt"></i> Open on Matcherino
        </a></p>
      </div>`;
    prev.style.display = "flex";
  } catch (e) {
    errEl.textContent = "Could not fetch: " + e.message;
    errEl.style.display = "block";
  }
}

async function addFromMatcherino() {
  const id = document.getElementById("mId").value.trim();
  const region = document.getElementById("mRegion").value;
  const errEl = document.getElementById("mError");
  errEl.style.display = "none";
  if (!/^\d+$/.test(id)) { errEl.textContent = "Enter a numeric Matcherino ID."; errEl.style.display = "block"; return; }
  try {
    const r = await api("/api/tournaments/from-matcherino",
      { method: "POST", body: { matcherino_id: parseInt(id, 10), region } });
    document.getElementById("mId").value = "";
    document.getElementById("mPreview").style.display = "none";
    alert(`Added: ${r.name}`);
    loadAdminTournaments();
    loadTournaments();
  } catch (e) {
    errEl.textContent = "Could not add: " + e.message;
    errEl.style.display = "block";
  }
}

async function loadAdminTournaments() {
  const list = document.getElementById("adminTournamentList");
  const items = await api("/api/tournaments");
  list.innerHTML = items.map(t => {
    const tag = t.matcherino_id
      ? `<span class="src-tag"><i class="fas fa-link"></i> Matcherino #${t.matcherino_id}</span>`
      : `<span class="src-tag manual">Manual</span>`;
    return `
    <div class="admin-item">
      <div class="admin-item-info">
        <h4>${esc(t.name)} ${tag}</h4>
        <p>${regionBadge(t.region)} / ${esc(t.prize || "-")} / ${fmtDate(t.date, true)} / <span class="yellow">${esc(t.computed_status)}</span></p>
      </div>
      <button class="btn-delete" onclick="deleteTournament(${t.id})"><i class="fas fa-trash"></i> Delete</button>
    </div>`;
  }).join("") || `<p class="empty">No tournaments yet.</p>`;
}
async function deleteTournament(id) {
  if (!confirm("Delete this tournament?")) return;
  await api(`/api/tournaments/${id}`, { method: "DELETE" });
  loadAdminTournaments(); loadTournaments();
}

// --- News admin ---
async function addNews() {
  const body = {
    title: document.getElementById("nTitle").value,
    category: document.getElementById("nCategory").value,
    image: document.getElementById("nImage").value,
    content: document.getElementById("nContent").value,
  };
  if (!body.title) return alert("Title required");
  await api("/api/news", { method: "POST", body });
  ["nTitle","nImage","nContent"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("nImagePreview").innerHTML = "";
  loadAdminNews();
}

async function loadAdminNews() {
  const list = document.getElementById("adminNewsList");
  const items = await api("/api/news");
  list.innerHTML = items.map(a => `
    <div class="admin-item">
      <div class="admin-item-info">
        <h4>${esc(a.title)}</h4>
        <p>${esc(a.category || "")} / ${fmtDate(a.date)}</p>
      </div>
      <button class="btn-delete" onclick="deleteNews(${a.id})"><i class="fas fa-trash"></i> Delete</button>
    </div>`).join("") || `<p class="empty">No articles yet.</p>`;
}
async function deleteNews(id) {
  if (!confirm("Delete this article?")) return;
  await api(`/api/news/${id}`, { method: "DELETE" });
  loadAdminNews();
}

// --- Winning admin (screenshot uploads) ---
async function addWinning() {
  const avatar = document.getElementById("wAvatar").value;
  const matcherinoId = document.getElementById("wMatcherinoId").value.trim();
  if (!avatar) return alert("Upload an image first");
  if (matcherinoId && !/^\d+$/.test(matcherinoId)) {
    return alert("Matcherino Tournament ID must contain numbers only");
  }
  const body = {
    type: "team",
    name: document.getElementById("wName").value,
    avatar,
    matcherino_id: matcherinoId ? Number(matcherinoId) : null,
  };
  await api("/api/winning", { method: "POST", body });
  ["wName","wMatcherinoId","wAvatar"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("wAvatarPreview").innerHTML = "";
  loadAdminWinning();
  loadWinning();
}

async function loadAdminWinning() {
  const list = document.getElementById("adminWinningList");
  const items = await api("/api/winning");
  list.innerHTML = items.map(w => `
    <div class="admin-item">
      <div class="admin-item-info">
        ${w.avatar ? `<img src="${esc(w.avatar)}" style="width:80px;height:auto;border-radius:6px;border:1px solid var(--border)"/>` : ""}
        <h4 style="display:inline-block;margin-left:.75rem;vertical-align:middle">${esc(w.name || "Untitled")}</h4>
        ${w.matcherino_id ? `<span class="src-tag"><i class="fas fa-link"></i> Matcherino #${esc(w.matcherino_id)}</span>` : ""}
      </div>
      <button class="btn-delete" onclick="deleteWinning(${w.id})"><i class="fas fa-trash"></i></button>
    </div>`).join("") || `<p class="empty">No winner cards yet.</p>`;
}
async function deleteWinning(id) {
  if (!confirm("Delete?")) return;
  await api(`/api/winning/${id}`, { method: "DELETE" });
  loadAdminWinning();
}

// --- About admin ---
async function loadAdminAbout() {
  const a = await api("/api/about");
  document.getElementById("aboutText").value = a.description || "";
  document.getElementById("aboutDiscord").value = a.discord || "";
}
async function saveAbout() {
  await api("/api/about", {
    method: "POST",
    body: {
      description: document.getElementById("aboutText").value,
      discord: document.getElementById("aboutDiscord").value,
    },
  });
  alert("Saved");
  loadAbout();
}

// --- Staff admin ---
async function addStaff() {
  const body = {
    name: document.getElementById("sName").value,
    role: document.getElementById("sRole").value,
    pfp: document.getElementById("sPfp").value,
    description: document.getElementById("sDesc").value,
    discord: document.getElementById("sDiscord").value.trim(),
    x_url: document.getElementById("sX").value.trim(),
  };
  if (!body.name) return alert("Name required");
  await api("/api/staff", { method: "POST", body });
  ["sName","sRole","sPfp","sDesc","sDiscord","sX"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("sPfpPreview").innerHTML = "";
  loadAdminStaff();
  loadAbout();
}
async function loadAdminStaff() {
  const list = document.getElementById("adminStaffList");
  const items = await api("/api/staff");
  list.innerHTML = items.map(m => `
    <div class="admin-item">
      <div class="admin-item-info">
        <h4>${esc(m.name)}</h4>
        <p>
          ${esc(m.role || "")}
          ${m.discord ? ` / Discord: ${esc(m.discord)}` : ""}
          ${m.x_url ? ` / X: ${esc(m.x_url)}` : ""}
        </p>
      </div>
      <button class="btn-delete" onclick="deleteStaff(${m.id})"><i class="fas fa-trash"></i></button>
    </div>`).join("") || `<p class="empty">No staff yet.</p>`;
}
async function deleteStaff(id) {
  if (!confirm("Delete?")) return;
  await api(`/api/staff/${id}`, { method: "DELETE" });
  loadAdminStaff();
}

// --- Partners admin ---
async function addPartner() {
  const body = {
    name: document.getElementById("pName").value,
    url: document.getElementById("pUrl").value,
    logo: document.getElementById("pLogo").value,
  };
  if (!body.name) return alert("Name required");
  await api("/api/partners", { method: "POST", body });
  ["pName","pUrl","pLogo"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("pLogoPreview").innerHTML = "";
  loadAdminPartners();
}
async function loadAdminPartners() {
  const list = document.getElementById("adminPartnerList");
  const items = await api("/api/partners");
  list.innerHTML = items.map(p => `
    <div class="admin-item">
      <div class="admin-item-info">
        <h4>${esc(p.name)}</h4>
        <p>${esc(p.url || "")}</p>
      </div>
      <button class="btn-delete" onclick="deletePartner(${p.id})"><i class="fas fa-trash"></i></button>
    </div>`).join("") || `<p class="empty">No partners yet.</p>`;
}
async function deletePartner(id) {
  if (!confirm("Delete?")) return;
  await api(`/api/partners/${id}`, { method: "DELETE" });
  loadAdminPartners();
}

// --- Tickets admin ---
let ticketFilter = "all";
let adminTickets = [];
let adminCurrentTicketCode = null;
let adminTicketsSnapshot = "";
let adminTicketPollTimer = null;
let adminTicketRefreshPending = false;

async function loadAdminTickets() {
  try {
    adminTickets = await api("/api/admin/tickets", { cache: "no-store" });
    adminTicketsSnapshot = JSON.stringify(adminTickets);
    renderAdminTickets();
  } catch (e) {
    document.getElementById("adminTicketsList").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function filterTickets(ev, f) {
  ticketFilter = f;
  document.querySelectorAll(".tickets-filter .filter-btn").forEach(b => b.classList.remove("active"));
  ev.currentTarget.classList.add("active");
  renderAdminTickets();
}

function renderAdminTickets() {
  const list = ticketFilter === "all"
    ? adminTickets
    : adminTickets.filter(t => t.status === ticketFilter);
  const c = document.getElementById("adminTicketsList");
  if (!list.length) { c.innerHTML = `<p class="empty">No tickets.</p>`; return; }
  c.innerHTML = list.map(t => {
    const last = t.messages[t.messages.length - 1] || {};
    const unread = last.author === "user";
    return `
      <div class="ticket-list-item ${adminCurrentTicketCode === t.code ? "selected" : ""}" onclick="openAdminTicket('${t.code}')">
        <div class="ticket-list-top">
          <span class="ticket-list-code">${t.code}</span>
          <span class="ticket-status-badge ${t.status}">${t.status === "open" ? "Open" : "Closed"}</span>
        </div>
        <div class="ticket-list-name"><i class="fab fa-discord"></i> ${esc(t.discord)}${unread ? `<span class="unread-dot"></span>` : ""}</div>
        <div class="ticket-list-subject">${esc(t.subject)}</div>
        <div class="ticket-list-preview">${esc((last.text || "").slice(0, 60))}${(last.text || "").length > 60 ? "..." : ""}</div>
        <div class="ticket-list-date">${fmtDate(t.date)}</div>
      </div>`;
  }).join("");
}

function openAdminTicket(code, { preserveScroll = false } = {}) {
  adminCurrentTicketCode = code;
  const t = adminTickets.find(x => x.code === code);
  if (!t) return;
  document.getElementById("adminTcCode").textContent = t.code;
  document.getElementById("adminTcSubject").textContent = t.subject;
  document.getElementById("adminTcDiscord").textContent = t.discord;
  document.getElementById("adminTcName").textContent = t.name;
  document.getElementById("adminTcDate").textContent = fmtDate(t.date, true);
  const badge = document.getElementById("adminTcStatus");
  badge.textContent = t.status === "open" ? "Open" : "Closed";
  badge.className = "ticket-status-badge " + t.status;
  document.getElementById("adminTcToggleBtn").innerHTML =
    t.status === "open" ? "Close" : "Reopen";
  document.getElementById("adminTcDeleteBtn").style.display =
    t.status === "closed" ? "inline-flex" : "none";

  const box = document.getElementById("adminTcMessages");
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  const previousScroll = box.scrollTop;
  box.innerHTML = t.messages.map(m => `
    <div class="chat-message ${m.author}">
      <div class="chat-bubble">
        <div class="chat-meta">
          <strong>${m.author === "admin" ? "YF7 Staff" : esc(m.authorName || "User")}</strong>
          <span>${fmtDate(m.date, true)}</span>
        </div>
        <p>${esc(m.text)}</p>
      </div>
    </div>`).join("");
  if (!preserveScroll || wasNearBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = previousScroll;
  document.getElementById("adminTicketChat").style.display = "flex";
  renderAdminTickets();
  startAdminTicketPolling();
}

async function refreshAdminTickets() {
  const messagesTab = document.getElementById("admin-messages");
  if (!adminLoggedIn || adminTicketRefreshPending || document.hidden ||
      !messagesTab?.classList.contains("active")) return;

  adminTicketRefreshPending = true;
  try {
    const latest = await api("/api/admin/tickets", { cache: "no-store" });
    const snapshot = JSON.stringify(latest);
    if (snapshot !== adminTicketsSnapshot) {
      adminTickets = latest;
      adminTicketsSnapshot = snapshot;
      renderAdminTickets();
      if (adminCurrentTicketCode && adminTickets.some(t => t.code === adminCurrentTicketCode)) {
        openAdminTicket(adminCurrentTicketCode, { preserveScroll: true });
      }
    }
  } catch (_) {
    // Keep the current admin conversation visible during temporary failures.
  } finally {
    adminTicketRefreshPending = false;
  }
}

function startAdminTicketPolling() {
  stopAdminTicketPolling();
  if (!adminLoggedIn) return;
  adminTicketPollTimer = window.setInterval(refreshAdminTickets, 3000);
}

function stopAdminTicketPolling() {
  if (adminTicketPollTimer) window.clearInterval(adminTicketPollTimer);
  adminTicketPollTimer = null;
  adminTicketRefreshPending = false;
}

async function sendAdminReply() {
  const input = document.getElementById("adminTcReplyInput");
  const text = input.value.trim();
  if (!text || !adminCurrentTicketCode) return;
  await api(`/api/admin/tickets/${encodeURIComponent(adminCurrentTicketCode)}/reply`,
    { method: "POST", body: { text } });
  input.value = "";
  await loadAdminTickets();
  openAdminTicket(adminCurrentTicketCode);
}

async function toggleTicketStatus() {
  if (!adminCurrentTicketCode) return;
  const t = adminTickets.find(x => x.code === adminCurrentTicketCode);
  if (!t) return;
  const newStatus = t.status === "open" ? "closed" : "open";
  await api(`/api/admin/tickets/${encodeURIComponent(adminCurrentTicketCode)}`,
    { method: "PATCH", body: { status: newStatus } });
  await loadAdminTickets();
  openAdminTicket(adminCurrentTicketCode);
}

async function deleteAdminTicket() {
  if (!adminCurrentTicketCode) return;
  if (!confirm("Delete this ticket permanently?")) return;
  await api(`/api/admin/tickets/${encodeURIComponent(adminCurrentTicketCode)}`,
    { method: "DELETE" });
  adminCurrentTicketCode = null;
  document.getElementById("adminTicketChat").style.display = "none";
  loadAdminTickets();
}

// ===== INIT =====
document.getElementById("footerYear").textContent = new Date().getFullYear();
loadTournaments();
loadAbout();
checkAdminSession();
preloadEsports();

// Route based on URL: /admin shows the admin page directly
if (window.location.pathname.replace(/\/$/, "") === "/admin") {
  showPage("admin");
}

// expose
Object.assign(window, {
  showPage, toggleMenu, closeMenu,
  filterTournaments,
  showRegion, showBracket, onBracketMonthChange, onBracketRegionChange, toggleBracketFullscreen,
  openNewsModal, closeModal,
  showContactTab, submitContact, copyTicketCode, searchTicket, sendUserReply,
  copyStaffDiscord,
  adminLogin, adminLogout, showAdminTab,
  deleteTournament, previewMatcherino, addFromMatcherino,
  addNews, deleteNews,
  addWinning, deleteWinning,
  saveAbout, addStaff, deleteStaff, addPartner, deletePartner,
  openLightbox,
  filterTickets, openAdminTicket, sendAdminReply, toggleTicketStatus, deleteAdminTicket,
});
