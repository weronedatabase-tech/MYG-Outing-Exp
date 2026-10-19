document.addEventListener("DOMContentLoaded", () => {
  if(localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
  } else {
      document.documentElement.classList.remove('dark');
  }

  const envBar = document.getElementById('envBar');
  if (envBar) {
      if (ENV === 'Dev') {
          envBar.innerText = 'Testing';
          envBar.classList.add('bg-red-600', 'border-red-800');
          envBar.classList.remove('hidden');
      } else if (ENV === 'Exp') {
          envBar.innerText = 'Experimentation';
          envBar.classList.add('bg-purple-600', 'border-purple-800');
          envBar.classList.remove('hidden');
      }
  }

  console.log(`Running in ${ENV} mode connected to: ${API_URL}`);

  initCollabNavbarBadge();
  bindGlobalCollabEvents();

  apiCall('getAppSettings', null).then(res => {
      if (res && res.success !== false) {
          appSettings = res;
      }
  });

  const savedKey = localStorage.getItem('adminKey');
  if (savedKey) {
      if (sessionStorage.getItem('adminKeyValidated') === savedKey) {
          isAdminAuthenticated = true;
      } else {
          apiCall('verifyAdminPassword', savedKey).then(isValid => {
              if (isValid) {
                  isAdminAuthenticated = true;
                  sessionStorage.setItem('adminKeyValidated', savedKey);
              } else {
                  localStorage.removeItem('adminKey');
                  sessionStorage.removeItem('adminKeyValidated');
                  isAdminAuthenticated = false;
              }
          });
      }
  }

  silentHydration();
});

function initCollabNavbarBadge() {
  const refreshBtn = document.querySelector('button[onclick="refreshApp()"]');
  if (!refreshBtn || !refreshBtn.parentElement) return;
  if (document.getElementById('collabPresenceBadge')) return;

  const badge = document.createElement('div');
  badge.id = 'collabPresenceBadge';
  badge.className = 'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 select-none mr-1 transition-all';
  badge.title = 'Real-Time Collaborative Sync Active';
  badge.innerHTML = `
      <span id="collabPresenceDot" class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
      <span id="collabPresenceText">Live</span>
  `;
  refreshBtn.parentElement.insertBefore(badge, refreshBtn);
  updateCollabNavbarBadge();
}

function updateCollabNavbarBadge() {
  const badge = document.getElementById('collabPresenceBadge');
  const dot = document.getElementById('collabPresenceDot');
  const txt = document.getElementById('collabPresenceText');
  if (!badge || !dot || !txt || !window.collabState) return;

  const connected = window.collabState.connected;
  const count = Math.max(1, window.collabState.onlineCount || 1);

  if (connected) {
      badge.className = 'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 select-none mr-1 transition-all';
      dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse';
      txt.textContent = count > 1 ? `${count} Live` : 'Live';
      const views = (window.collabState.sheetUsers || []).map(u => u.label || u.view).filter(Boolean);
      badge.title = count > 1
          ? `${count} collaborators active (${views.join(', ')})`
          : 'Real-Time Collaborative Sync Active';
  } else {
      badge.className = 'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 select-none mr-1 transition-all';
      dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping';
      txt.textContent = 'Syncing';
      badge.title = 'Reconnecting to live session...';
  }
}

window.applyAllCollabRemoteFocus = function() {
  // Remove stale focus indicators first
  document.querySelectorAll('.collab-remote-focus').forEach(el => {
      el.classList.remove('collab-remote-focus');
      el.style.removeProperty('--collab-color');
      const oldBadge = el.querySelector('.collab-focus-badge');
      if (oldBadge) oldBadge.remove();
  });

  if (!window.collabState || !window.collabState.remoteFocusMap) return;
  const now = Date.now();

  for (const [clientId, info] of window.collabState.remoteFocusMap.entries()) {
      if (!info || !info.item || !info.item.name || (info.expiresAt && info.expiresAt < now)) {
          window.collabState.remoteFocusMap.delete(clientId);
          continue;
      }
      const targetName = info.item.name;
      const cards = document.querySelectorAll('.comm-att-card, .bus-att-card, .dnd-dropzone, .grouping-card');
      cards.forEach(card => {
          const cardName = card.getAttribute('data-name');
          if (cardName && cardName.toLowerCase() === targetName.toLowerCase()) {
              card.classList.add('collab-remote-focus');
              card.style.setProperty('--collab-color', info.color || '#3b82f6');
              if (!card.querySelector('.collab-focus-badge')) {
                  const b = document.createElement('div');
                  b.className = 'collab-focus-badge';
                  b.style.setProperty('--collab-color', info.color || '#3b82f6');
                  b.textContent = info.item.action === 'moving' ? 'Moving' : 'Editing';
                  card.appendChild(b);
              }
          }
      });
  }
};

function bindGlobalCollabEvents() {
  if (typeof window.collabOn !== 'function') return;

  window.collabOn('connection:state', () => {
      updateCollabNavbarBadge();
  });

  window.collabOn('presence:state', () => {
      updateCollabNavbarBadge();
  });

  window.collabOn('ephemeral:focus', (msg) => {
      if (!msg || !msg.clientId) return;
      if (!msg.item) {
          window.collabState.remoteFocusMap.delete(msg.clientId);
      } else {
          window.collabState.remoteFocusMap.set(msg.clientId, {
              clientId: msg.clientId,
              color: msg.color || '#3b82f6',
              label: msg.label || 'Collaborator',
              item: msg.item,
              expiresAt: Date.now() + 30000
          });
      }
      window.applyAllCollabRemoteFocus();
  });

  window.collabOn('global:outingsUpdated', (msg) => {
      if (msg && Array.isArray(msg.sheets)) {
          const activeSheets = window.filterActiveOutings(msg.sheets);
          currentSheetList = activeSheets;
          try {
              localStorage.setItem('myg_sheetList', JSON.stringify(activeSheets));
          } catch (e) {}

          if (typeof populateHomeSelectors === 'function') {
              populateHomeSelectors(activeSheets);
          }
          if (typeof renderCommDashboardCards === 'function' && document.getElementById('upcomingList')) {
              loadSheets('comm', true);
          }
          if (typeof loadVolunteerEvents === 'function' && document.getElementById('volEventName')) {
              loadVolunteerEvents();
          }
      }
  });

  window.collabOn('global:settingsUpdated', (msg) => {
      if (msg && msg.settings) {
          appSettings = msg.settings;
          window.appSettings = msg.settings;
          if (typeof loadSettings === 'function' && document.getElementById('settingsContent')) {
              loadSettings();
          }
      }
  });
}

window.getOutingThresholdDateNum = function() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const tY = d.getFullYear();
  const tM = String(d.getMonth() + 1).padStart(2, '0');
  const tD = String(d.getDate()).padStart(2, '0');
  return parseInt(`${tY}${tM}${tD}`, 10);
};

window.filterActiveOutings = function(data) {
  if (!Array.isArray(data)) return [];
  const threshold = window.getOutingThresholdDateNum();
  return data.filter(item => {
      if (!item) return false;
      let dateNum = item.folderDateNum ? parseInt(item.folderDateNum, 10) : NaN;
      if (isNaN(dateNum) && item.fullName) {
          const m = String(item.fullName).match(/(\d{8})/);
          if (m) dateNum = parseInt(m[1], 10);
      }
      if (isNaN(dateNum) && item.formattedDate) {
          const parsed = new Date(item.formattedDate);
          if (!isNaN(parsed.getTime())) {
              const y = parsed.getFullYear();
              const m = String(parsed.getMonth() + 1).padStart(2, '0');
              const d = String(parsed.getDate()).padStart(2, '0');
              dateNum = parseInt(`${y}${m}${d}`, 10);
          }
      }
      return isNaN(dateNum) ? true : dateNum >= threshold;
  });
};

function silentHydration() {
  if (isHydrated) return;
  
  apiCall('getRecentOutingSheets', null).then(res => {
      if (res && res.success && Array.isArray(res.data)) {
          const activeData = window.filterActiveOutings(res.data);
          currentSheetList = activeData;
          localStorage.setItem('myg_sheetList', JSON.stringify(activeData)); // Core MPA Pre-cache
          isHydrated = true;
      }
  }).catch(e => console.warn("Hydration failed silently", e));
}

// Global utility to find the most immediate upcoming event
window.getClosestEventUrl = function(data) {
  const activeData = window.filterActiveOutings ? window.filterActiveOutings(data) : data;
  if(!activeData || activeData.length === 0) return null;
  if(activeData.length === 1) return activeData[0].sheetUrl;
  
  const today = new Date();
  const tY = today.getFullYear();
  const tM = String(today.getMonth() + 1).padStart(2, '0');
  const tD = String(today.getDate()).padStart(2, '0');
  const todayNum = parseInt(`${tY}${tM}${tD}`);
  
  // The backend data array is now sorted ascending by folderDateNum (earliest to latest)
  let closestFuture = null;
  for(let i = 0; i < activeData.length; i++) {
      if(activeData[i].folderDateNum >= todayNum) {
          closestFuture = activeData[i];
          break;
      }
  }
  
  if(closestFuture) return closestFuture.sheetUrl;
  
  // If no future events exist, return the most recent past event (which is the last item)
  return activeData[activeData.length - 1].sheetUrl;
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then(reg => {
          console.log('Service Worker Registered successfully');
      }).catch(err => {
          console.warn('Service Worker registration failed:', err);
      });
  });
}