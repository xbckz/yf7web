// ===== FIREBASE CONFIG =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, onValue, push, set, remove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCJnJ-cxVACUY1o0zVVYee2t4M5qUviSi8",
  authDomain: "yf7-tournaments.firebaseapp.com",
  databaseURL: "https://yf7-tournaments-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "yf7-tournaments",
  storageBucket: "yf7-tournaments.firebasestorage.app",
  messagingSenderId: "275093997844",
  appId: "1:275093997844:web:f643c440146bcc6dc21a01",
  measurementId: "G-EYRHEE4BEG"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ===== NAVIGATION =====
function showPage(eventOrPageName, maybePageName) {
  let event = null;
  let pageName = maybePageName;

  if (typeof eventOrPageName === 'string') {
    pageName = eventOrPageName;
  } else {
    event = eventOrPageName;
  }

  if (event) event.preventDefault();

  document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));

  const targetPage = document.getElementById(`page-${pageName}`);
  if (targetPage) targetPage.classList.add('active');

  document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
  if (event?.target) event.target.classList.add('active');
}

function toggleMenu() {
  document.getElementById('navLinks').classList.toggle('active');
}

function closeMenu() {
  document.getElementById('navLinks').classList.remove('active');
}

// ===== SCROLL NAVBAR =====
window.addEventListener('scroll', () => {
  const navbar = document.getElementById('navbar');
  navbar.classList.toggle('scrolled', window.scrollY > 50);
});

// ===== TOURNAMENTS =====
function loadTournaments() {
  const tournamentsRef = ref(db, 'tournaments');
  onValue(tournamentsRef, (snapshot) => {
    const grid = document.getElementById('tournamentsGrid');
    grid.innerHTML = '';

    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, tournament]) => {
        grid.appendChild(createTournamentCard(tournament, key));
      });
    } else {
      grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-muted)">Aucun tournoi pour le moment</p>';
    }
  });
}

function createTournamentCard(tournament, key) {
  const card = document.createElement('a');
  card.href = tournament.link || '#';
  card.target = '_blank';
  card.className = 'tournament-card';

  const date = new Date(tournament.date);
  const status = date < new Date() ? 'past' : 'upcoming';

  card.innerHTML = `
    <div class="tournament-banner-placeholder">🏆</div>
    <div class="tournament-info">
      <span class="tournament-status status-${status}">${status === 'upcoming' ? '📅 À venir' : '✅ Passé'}</span>
      <h3>${tournament.name}</h3>
      <div class="tournament-meta">
        <span><i class="fas fa-calendar"></i> ${date.toLocaleDateString('fr-FR')}</span>
        <span><i class="fas fa-map"></i> ${tournament.region}</span>
        <span class="prize"><i class="fas fa-trophy"></i> ${tournament.prize}</span>
      </div>
      <p style="font-size:0.85rem;color:var(--text-muted);margin-top:0.75rem">${tournament.description || ''}</p>
    </div>
  `;
  return card;
}

// ===== ESPORTS =====
let currentRegion = 'eu';
let currentBracket = 'mq';

function showRegion(region) {
  currentRegion = region;
  document.querySelectorAll('.regions-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
  const regionNames = { eu: 'Europe', na: 'North America', latam: 'LATAM', asia: 'Asia', mena: 'MENA' };
  document.getElementById('currentRegion').textContent = regionNames[region];
  loadLeaderboard(region);
}

function loadLeaderboard(region) {
  const lbRef = ref(db, `esports/${region}/leaderboard`);
  onValue(lbRef, (snapshot) => {
    const table = document.getElementById('leaderboardTable');
    table.innerHTML = '';

    if (snapshot.exists()) {
      const sorted = Object.entries(snapshot.val()).sort((a, b) => b[1].points - a[1].points);
      sorted.forEach(([key, player], index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
        const rankClass = index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : '';
        const row = document.createElement('div');
        row.className = 'leaderboard-row';
        row.innerHTML = `
          <div class="lb-rank ${rankClass}">${medal} ${index + 1}</div>
          <div class="lb-name">${player.name || key}</div>
          <div class="lb-points">${player.points} pts</div>
        `;
        table.appendChild(row);
      });
    } else {
      table.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:2rem">Pas de données</p>';
    }
  });
}

function showBracket(type) {
  currentBracket = type;
  document.querySelectorAll('.brackets-tabs .bracket-tab').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
}

// ===== WINNING TEAMS =====
function showWinning(type) {
  document.querySelectorAll('.winning-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
  loadWinning(type);
}

function loadWinning(type) {
  const path = type === 'players' ? 'winning/players' : 'winning/teams';
  onValue(ref(db, path), (snapshot) => {
    const grid = document.getElementById('winningGrid');
    grid.innerHTML = '';

    if (snapshot.exists()) {
      const sorted = Object.entries(snapshot.val()).sort((a, b) => b[1].wins - a[1].wins);
      sorted.forEach(([key, item], index) => {
        const rankClass = index === 0 ? 'r1' : index === 1 ? 'r2' : index === 2 ? 'r3' : '';
        const card = document.createElement('div');
        card.className = 'winning-card';
        card.innerHTML = `
          <div class="winning-rank ${rankClass}">#${index + 1}</div>
          <img src="${item.avatar || 'https://via.placeholder.com/50'}" alt="${item.name}" class="winning-avatar"/>
          <div class="winning-info">
            <h4>${item.name}</h4>
            <p>${type === 'players' ? 'Joueur' : 'Équipe'}</p>
          </div>
          <div class="winning-stats">
            <div class="wins">${item.wins}W</div>
            <div class="earnings">€${item.earnings || 0}</div>
          </div>
        `;
        grid.appendChild(card);
      });
    }
  });
}

// ===== NEWS =====
function loadNews() {
  onValue(ref(db, 'news'), (snapshot) => {
    const grid = document.getElementById('newsGrid');
    grid.innerHTML = '';

    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, article]) => {
        const card = document.createElement('div');
        card.className = 'news-card';
        card.onclick = () => openNewsModal(article);
        card.innerHTML = `
          <div class="news-img-placeholder">📰</div>
          <div class="news-content">
            <span class="news-category">${article.category || 'News'}</span>
            <h3>${article.title}</h3>
            <p>${article.content}</p>
            <div class="news-date"><i class="fas fa-clock"></i> ${new Date(article.date || Date.now()).toLocaleDateString('fr-FR')}</div>
          </div>
        `;
        grid.appendChild(card);
      });
    }
  });
}

function openNewsModal(article) {
  document.getElementById('newsModalContent').innerHTML = `
    <span class="news-category" style="display:inline-block;margin-bottom:1rem">${article.category || 'News'}</span>
    <h2 style="font-size:2rem;margin-bottom:1rem">${article.title}</h2>
    <p style="color:var(--text-muted);margin-bottom:1.5rem"><i class="fas fa-calendar"></i> ${new Date(article.date || Date.now()).toLocaleDateString('fr-FR')}</p>
    <div style="line-height:1.8;font-size:1.05rem">${article.content}</div>
  `;
  document.getElementById('newsModal').classList.add('open');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('open');
}

// ===== CONTACT / TICKETS =====
let currentTicketId = null;
let adminCurrentTicketId = null;

function generateTicketCode() {
  return 'YF7-' + Math.floor(1000 + Math.random() * 9000);
}

function getTickets() {
  return JSON.parse(localStorage.getItem('yf7_tickets') || '{}');
}

function saveTickets(tickets) {
  localStorage.setItem('yf7_tickets', JSON.stringify(tickets));
}

function showContactTab(tab) {
  document.querySelectorAll('.contact-tab-content').forEach(el => el.classList.remove('active'));
  document.getElementById('contact-' + tab).classList.add('active');
  document.querySelectorAll('.contact-tabs .tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', (tab === 'new' && i === 0) || (tab === 'check' && i === 1));
  });
  if (tab === 'new') {
    document.getElementById('contactSuccess').style.display = 'none';
    const submitBtn = document.querySelector('#contactForm button[type=submit]');
    if (submitBtn) submitBtn.style.display = 'block';
  }
}

function submitContact(event) {
  event.preventDefault();

  const name = document.getElementById('contactName').value.trim();
  const discord = document.getElementById('contactDiscord').value.trim();
  const subject = document.getElementById('contactSubject').value;
  const message = document.getElementById('contactMessage').value.trim();

  const code = generateTicketCode();
  const ticket = {
    code, name, discord, subject,
    status: 'open',
    date: new Date().toISOString(),
    messages: [{ author: 'user', authorName: name, text: message, date: new Date().toISOString() }]
  };

  const tickets = getTickets();
  tickets[code] = ticket;
  saveTickets(tickets);

  const submitBtn = document.querySelector('#contactForm button[type=submit]');
  if (submitBtn) submitBtn.style.display = 'none';
  document.getElementById('contactSuccess').style.display = 'block';
  document.getElementById('ticketCodeDisplay').textContent = code;
  currentTicketId = code;

  document.getElementById('contactName').value = '';
  document.getElementById('contactDiscord').value = '';
  document.getElementById('contactMessage').value = '';
}

function copyTicketCode() {
  const code = document.getElementById('ticketCodeDisplay').textContent;
  navigator.clipboard.writeText(code);
  alert('✅ Code copied: ' + code);
}

function searchTicket() {
  const code = document.getElementById('ticketSearchInput').value.trim().toUpperCase();
  const ticket = getTickets()[code];

  document.getElementById('ticketNotFound').style.display = 'none';
  document.getElementById('ticketChatBox').style.display = 'none';

  if (!ticket) {
    document.getElementById('ticketNotFound').style.display = 'block';
    return;
  }

  currentTicketId = code;
  renderUserTicketChat(ticket);
}

function renderUserTicketChat(ticket) {
  document.getElementById('tcCode').textContent = ticket.code;
  document.getElementById('tcSubject').textContent = ticket.subject;
  document.getElementById('tcStatus').textContent = ticket.status === 'open' ? '🟢 Open' : '🔴 Closed';

  const msgContainer = document.getElementById('tcMessages');
  msgContainer.innerHTML = ticket.messages.map(msg => `
    <div class="chat-message ${msg.author}">
      <div class="chat-bubble">
        <div class="chat-meta">
          <strong>${msg.author === 'admin' ? '⚡ YF7 Staff' : msg.authorName}</strong>
          <span>${new Date(msg.date).toLocaleString('fr-FR')}</span>
        </div>
        <p>${msg.text}</p>
      </div>
    </div>
  `).join('');
  msgContainer.scrollTop = msgContainer.scrollHeight;

  document.getElementById('ticketChatBox').style.display = 'block';
  document.getElementById('tcReplyArea').style.display = ticket.status === 'open' ? 'flex' : 'none';
}

function sendUserReply() {
  const input = document.getElementById('tcReplyInput');
  const text = input.value.trim();
  if (!text || !currentTicketId) return;

  const tickets = getTickets();
  const ticket = tickets[currentTicketId];
  if (!ticket) return;

  ticket.messages.push({ author: 'user', authorName: ticket.name, text, date: new Date().toISOString() });
  saveTickets(tickets);
  input.value = '';
  renderUserTicketChat(ticket);
}

// ===== ABOUT =====
function loadAbout() {
  onValue(ref(db, 'about'), (snapshot) => {
    if (snapshot.exists()) {
      const about = snapshot.val();
      document.getElementById('aboutDescription').innerHTML = `<p>${about.description || ''}</p>`;
    }
  });
  loadStaff();
  loadPartners();
}

function loadStaff() {
  onValue(ref(db, 'staff'), (snapshot) => {
    const grid = document.getElementById('staffGrid');
    grid.innerHTML = '';
    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, member]) => {
        const card = document.createElement('div');
        card.className = 'staff-card';
        card.innerHTML = `
          <img src="${member.pfp || 'https://via.placeholder.com/80'}" alt="${member.name}" class="staff-pfp"/>
          <h4>${member.name}</h4>
          <div class="staff-role">${member.role}</div>
          <p class="staff-desc">${member.description}</p>
        `;
        grid.appendChild(card);
      });
    }
  });
}

function loadPartners() {
  onValue(ref(db, 'partners'), (snapshot) => {
    const grid = document.getElementById('partnersGrid');
    grid.innerHTML = '';
    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, partner]) => {
        const card = document.createElement('a');
        card.href = partner.url;
        card.target = '_blank';
        card.className = 'partner-card';
        card.innerHTML = `
          <img src="${partner.logo}" alt="${partner.name}" class="partner-logo"/>
          <span class="partner-name">${partner.name}</span>
        `;
        grid.appendChild(card);
      });
    }
  });
}

// ===== ADMIN AUTH =====
const ADMIN_EMAIL = 'admin@yf7tournaments.fr';
const ADMIN_PASSWORD = 'yf7tournaments2026';

function adminLogin(event) {
  event.preventDefault();
  const email = document.getElementById('adminEmail').value;
  const password = document.getElementById('adminPassword').value;

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    document.getElementById('adminLogin').style.display = 'none';
    document.getElementById('adminPanel').style.display = 'block';
    localStorage.setItem('adminLoggedIn', 'true');
    loadAdminData();
  } else {
    document.getElementById('loginError').style.display = 'block';
    setTimeout(() => document.getElementById('loginError').style.display = 'none', 3000);
  }
}

function adminLogout() {
  localStorage.removeItem('adminLoggedIn');
  location.reload();
}

function showAdminTab(tabName) {
  document.querySelectorAll('.admin-tab-content').forEach(tab => tab.classList.remove('active'));
  document.getElementById(`admin-${tabName}`).classList.add('active');
  document.querySelectorAll('.admin-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');

  if (tabName === 'messages') loadAdminMessages();
}

// ===== ADMIN DATA =====
function loadAdminData() {
  loadAdminTournaments();
  loadAdminNews();
  loadAdminWinning();
  loadAdminStaff();
  loadAdminPartners();
  loadAdminMessages();
}

function addTournament() {
  const tournament = {
    name: document.getElementById('tName').value,
    date: document.getElementById('tDate').value,
    prize: document.getElementById('tPrize').value,
    region: document.getElementById('tRegion').value,
    link: document.getElementById('tLink').value,
    description: document.getElementById('tDesc').value
  };
  push(ref(db, 'tournaments'), tournament).then(() => {
    ['tName','tDate','tPrize','tLink','tDesc'].forEach(id => document.getElementById(id).value = '');
    loadAdminTournaments();
  });
}

function loadAdminTournaments() {
  onValue(ref(db, 'tournaments'), (snapshot) => {
    const list = document.getElementById('adminTournamentList');
    list.innerHTML = '';
    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, tournament]) => {
        const item = document.createElement('div');
        item.className = 'admin-item';
        item.innerHTML = `
          <div class="admin-item-info">
            <h4>${tournament.name}</h4>
            <p>${tournament.region} • ${tournament.prize} • ${new Date(tournament.date).toLocaleDateString('fr-FR')}</p>
          </div>
          <button class="btn-delete" onclick="deleteTournament('${key}')"><i class="fas fa-trash"></i> Supprimer</button>
        `;
        list.appendChild(item);
      });
    }
  });
}

function deleteTournament(key) {
  if (confirm('Supprimer ce tournoi?')) remove(ref(db, `tournaments/${key}`));
}

function addNews() {
  const article = {
    title: document.getElementById('nTitle').value,
    category: document.getElementById('nCategory').value,
    content: document.getElementById('nContent').value,
    image: document.getElementById('nImage').value,
    date: new Date().toISOString()
  };
  push(ref(db, 'news'), article).then(() => {
    ['nTitle','nContent','nImage'].forEach(id => document.getElementById(id).value = '');
    loadAdminNews();
  });
}

function loadAdminNews() {
  onValue(ref(db, 'news'), (snapshot) => {
    const list = document.getElementById('adminNewsList');
    list.innerHTML = '';
    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, article]) => {
        const item = document.createElement('div');
        item.className = 'admin-item';
        item.innerHTML = `
          <div class="admin-item-info">
            <h4>${article.title}</h4>
            <p>${article.category}</p>
          </div>
          <button class="btn-delete" onclick="deleteNews('${key}')"><i class="fas fa-trash"></i> Supprimer</button>
        `;
        list.appendChild(item);
      });
    }
  });
}

function deleteNews(key) {
  if (confirm('Supprimer cet article?')) remove(ref(db, `news/${key}`));
}

function addWinning() {
  const type = document.getElementById('wType').value;
  const entry = {
    name: document.getElementById('wName').value,
    wins: parseInt(document.getElementById('wWins').value),
    earnings: parseInt(document.getElementById('wEarnings').value),
    avatar: document.getElementById('wAvatar').value
  };
  const path = type === 'player' ? 'winning/players' : 'winning/teams';
  push(ref(db, path), entry).then(() => {
    ['wName','wWins','wEarnings','wAvatar'].forEach(id => document.getElementById(id).value = '');
    loadAdminWinning();
  });
}

function loadAdminWinning() {
  const list = document.getElementById('adminWinningList');
  list.innerHTML = '';

  onValue(ref(db, 'winning/players'), (snapshot) => {
    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, player]) => {
        const item = document.createElement('div');
        item.className = 'admin-item';
        item.innerHTML = `
          <div class="admin-item-info"><h4>👤 ${player.name}</h4><p>${player.wins} victoires • €${player.earnings}</p></div>
          <button class="btn-delete" onclick="deleteWinning('winning/players/${key}')"><i class="fas fa-trash"></i></button>
        `;
        list.appendChild(item);
      });
    }
  });

  onValue(ref(db, 'winning/teams'), (snapshot) => {
    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, team]) => {
        const item = document.createElement('div');
        item.className = 'admin-item';
        item.innerHTML = `
          <div class="admin-item-info"><h4>👥 ${team.name}</h4><p>${team.wins} victoires • €${team.earnings}</p></div>
          <button class="btn-delete" onclick="deleteWinning('winning/teams/${key}')"><i class="fas fa-trash"></i></button>
        `;
        list.appendChild(item);
      });
    }
  });
}

function deleteWinning(path) {
  if (confirm('Supprimer?')) remove(ref(db, path));
}

function saveAbout() {
  set(ref(db, 'about/description'), document.getElementById('aboutText').value)
    .then(() => alert('✅ Description mise à jour!'));
}

function addStaff() {
  const staff = {
    name: document.getElementById('sName').value,
    role: document.getElementById('sRole').value,
    pfp: document.getElementById('sPfp').value,
    description: document.getElementById('sDesc').value
  };
  push(ref(db, 'staff'), staff).then(() => {
    ['sName','sRole','sPfp','sDesc'].forEach(id => document.getElementById(id).value = '');
    loadAdminStaff();
  });
}

function loadAdminStaff() {
  onValue(ref(db, 'staff'), (snapshot) => {
    const list = document.getElementById('adminStaffList');
    list.innerHTML = '';
    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, member]) => {
        const item = document.createElement('div');
        item.className = 'admin-item';
        item.innerHTML = `
          <div class="admin-item-info"><h4>${member.name}</h4><p>${member.role}</p></div>
          <button class="btn-delete" onclick="deleteStaff('${key}')"><i class="fas fa-trash"></i></button>
        `;
        list.appendChild(item);
      });
    }
  });
}

function deleteStaff(key) {
  if (confirm('Supprimer ce membre?')) remove(ref(db, `staff/${key}`));
}

function addPartner() {
  const partner = {
    name: document.getElementById('pName').value,
    url: document.getElementById('pUrl').value,
    logo: document.getElementById('pLogo').value
  };
  push(ref(db, 'partners'), partner).then(() => {
    ['pName','pUrl','pLogo'].forEach(id => document.getElementById(id).value = '');
    loadAdminPartners();
  });
}

function loadAdminPartners() {
  onValue(ref(db, 'partners'), (snapshot) => {
    const list = document.getElementById('adminPartnerList');
    list.innerHTML = '';
    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([key, partner]) => {
        const item = document.createElement('div');
        item.className = 'admin-item';
        item.innerHTML = `
          <div class="admin-item-info"><h4>${partner.name}</h4><p>${partner.url}</p></div>
          <button class="btn-delete" onclick="deletePartner('${key}')"><i class="fas fa-trash"></i></button>
        `;
        list.appendChild(item);
      });
    }
  });
}

function deletePartner(key) {
  if (confirm('Supprimer ce partenaire?')) remove(ref(db, `partners/${key}`));
}

function addLeaderboard() {
  const region = document.getElementById('eRegion').value;
  const entry = {
    name: document.getElementById('eName').value,
    points: parseInt(document.getElementById('ePoints').value),
    flag: document.getElementById('eFlag').value
  };
  push(ref(db, `esports/${region}/leaderboard`), entry).then(() => {
    ['eName','ePoints','eFlag'].forEach(id => document.getElementById(id).value = '');
    loadAdminEsports();
  });
}

function loadAdminEsports() {
  const list = document.getElementById('adminEsportsList');
  list.innerHTML = '';
  ['eu','na','latam','asia','mena'].forEach(region => {
    onValue(ref(db, `esports/${region}/leaderboard`), (snapshot) => {
      if (snapshot.exists()) {
        Object.entries(snapshot.val()).forEach(([key, entry]) => {
          const item = document.createElement('div');
          item.className = 'admin-item';
          item.innerHTML = `
            <div class="admin-item-info"><h4>${entry.flag || ''} ${entry.name}</h4><p>${region.toUpperCase()} • ${entry.points} pts</p></div>
            <button class="btn-delete" onclick="deleteLeaderboard('${region}','${key}')"><i class="fas fa-trash"></i></button>
          `;
          list.appendChild(item);
        });
      }
    });
  });
}

function deleteLeaderboard(region, key) {
  if (confirm('Supprimer?')) remove(ref(db, `esports/${region}/leaderboard/${key}`));
}

// ===== ADMIN TICKETS =====
let ticketFilter = 'all';

function loadAdminMessages() {
  renderAdminTicketsList(getTickets());
}

function filterTickets(filter) {
  ticketFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
  loadAdminMessages();
}

function renderAdminTicketsList(tickets) {
  const container = document.getElementById('adminTicketsList');
  let list = Object.values(tickets).sort((a, b) => new Date(b.date) - new Date(a.date));

  if (ticketFilter !== 'all') list = list.filter(t => t.status === ticketFilter);

  if (list.length === 0) {
    container.innerHTML = '<p style="color:#888;padding:1rem">No tickets found.</p>';
    return;
  }

  container.innerHTML = list.map(ticket => {
    const lastMsg = ticket.messages[ticket.messages.length - 1];
    const unread = lastMsg.author === 'user';
    return `
      <div class="ticket-list-item ${adminCurrentTicketId === ticket.code ? 'selected' : ''}" onclick="openAdminTicket('${ticket.code}')">
        <div class="ticket-list-top">
          <span class="ticket-list-code">${ticket.code}</span>
          <span class="ticket-status-badge ${ticket.status}">${ticket.status === 'open' ? '🟢 Open' : '🔴 Closed'}</span>
        </div>
        <div class="ticket-list-name"><i class="fab fa-discord"></i> ${ticket.discord}${unread ? '<span class="unread-dot"></span>' : ''}</div>
        <div class="ticket-list-subject">${ticket.subject}</div>
        <div class="ticket-list-preview">${lastMsg.text.substring(0, 60)}${lastMsg.text.length > 60 ? '...' : ''}</div>
        <div class="ticket-list-date">${new Date(ticket.date).toLocaleDateString('fr-FR')}</div>
      </div>
    `;
  }).join('');
}

function openAdminTicket(code) {
  adminCurrentTicketId = code;
  const tickets = getTickets();
  const ticket = tickets[code];
  if (!ticket) return;

  document.getElementById('adminTcCode').textContent = ticket.code;
  document.getElementById('adminTcSubject').textContent = ticket.subject;
  document.getElementById('adminTcDiscord').textContent = ticket.discord;
  document.getElementById('adminTcName').textContent = ticket.name;
  document.getElementById('adminTcDate').textContent = new Date(ticket.date).toLocaleString('fr-FR');

  const statusEl = document.getElementById('adminTcStatus');
  statusEl.textContent = ticket.status === 'open' ? '🟢 Open' : '🔴 Closed';
  statusEl.className = 'ticket-status-badge ' + ticket.status;

  document.getElementById('adminTcToggleBtn').textContent = ticket.status === 'open' ? '🔴 Close Ticket' : '🟢 Reopen';
  const deleteBtn = document.getElementById('adminTcDeleteBtn');
  deleteBtn.style.display = ticket.status === 'closed' ? 'inline-flex' : 'none';

  const msgContainer = document.getElementById('adminTcMessages');
  msgContainer.innerHTML = ticket.messages.map(msg => `
    <div class="chat-message ${msg.author}">
      <div class="chat-bubble">
        <div class="chat-meta">
          <strong>${msg.author === 'admin' ? '⚡ YF7 Staff' : msg.authorName}</strong>
          <span>${new Date(msg.date).toLocaleString('fr-FR')}</span>
        </div>
        <p>${msg.text}</p>
      </div>
    </div>
  `).join('');
  msgContainer.scrollTop = msgContainer.scrollHeight;

  document.getElementById('adminTicketChat').style.display = 'flex';
  renderAdminTicketsList(tickets);
}

function adminReplyTicket() {
  const input = document.getElementById('adminTcReplyInput');
  const text = input.value.trim();
  if (!text || !adminCurrentTicketId) return;

  const tickets = getTickets();
  const ticket = tickets[adminCurrentTicketId];
  if (!ticket) return;

  ticket.messages.push({ author: 'admin', authorName: 'YF7 Staff', text, date: new Date().toISOString() });
  saveTickets(tickets);
  input.value = '';
  openAdminTicket(adminCurrentTicketId);
}

function toggleTicketStatus() {
  if (!adminCurrentTicketId) return;
  const tickets = getTickets();
  const ticket = tickets[adminCurrentTicketId];
  if (!ticket) return;

  ticket.status = ticket.status === 'open' ? 'closed' : 'open';
  saveTickets(tickets);
  openAdminTicket(adminCurrentTicketId);
}

function deleteAdminTicket() {
  if (!adminCurrentTicketId) return;
  const tickets = getTickets();
  if (!tickets[adminCurrentTicketId]) return;

  delete tickets[adminCurrentTicketId];
  saveTickets(tickets);
  adminCurrentTicketId = null;
  document.getElementById('adminTicketChat').style.display = 'none';
  loadAdminMessages();
}

// ===== INIT =====
window.addEventListener('load', () => {
  if (localStorage.getItem('adminLoggedIn') === 'true') {
    document.getElementById('adminLogin').style.display = 'none';
    document.getElementById('adminPanel').style.display = 'block';
    loadAdminData();
  }
  loadTournaments();
  loadNews();
  loadAbout();
});

// ===== EXPOSE TO WINDOW =====
window.showPage = showPage;
window.toggleMenu = toggleMenu;
window.closeMenu = closeMenu;
window.showRegion = showRegion;
window.showBracket = showBracket;
window.showWinning = showWinning;
window.closeModal = closeModal;
window.showContactTab = showContactTab;
window.submitContact = submitContact;
window.copyTicketCode = copyTicketCode;
window.searchTicket = searchTicket;
window.sendUserReply = sendUserReply;
window.adminLogin = adminLogin;
window.adminLogout = adminLogout;
window.showAdminTab = showAdminTab;
window.addTournament = addTournament;
window.addNews = addNews;
window.addWinning = addWinning;
window.saveAbout = saveAbout;
window.addStaff = addStaff;
window.addPartner = addPartner;
window.addLeaderboard = addLeaderboard;
window.deleteTournament = deleteTournament;
window.deleteNews = deleteNews;
window.deleteWinning = deleteWinning;
window.deleteStaff = deleteStaff;
window.deletePartner = deletePartner;
window.deleteLeaderboard = deleteLeaderboard;
window.filterTickets = filterTickets;
window.openAdminTicket = openAdminTicket;
window.adminReplyTicket = adminReplyTicket;
window.sendAdminReply = adminReplyTicket;
window.toggleTicketStatus = toggleTicketStatus;
window.deleteAdminTicket = deleteAdminTicket;
