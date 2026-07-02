let currentGroupingSheetUrl = null;
let groupingData = { trainees: [], volunteers: [], meetingLocs: [], dismissalLocs: [] };
let pendingGroupingUpdates = [];
let isGroupingSyncing = false;
let groupingSyncTimeout = null;
let groupingPollInterval = null;
let currentGroupingFilter = "ALL";
let currentGroupingSearch = "";
let currentGroupingTargetName = "";
let lastGroupingLocalChange = 0;

const EXPORT_COLORS = [
'#fef2f2', // red-50
'#eff6ff', // blue-50
'#f0fdf4', // green-50
'#fefce8', // yellow-50
'#faf5ff', // purple-50
'#fff7ed', // orange-50
'#f0fdfa', // teal-50
'#fdf2f8', // pink-50
'#eef2ff'  // indigo-50
];

// ==========================================
// MANUAL GROUPING LOGIC (Vertical List UI)
// ==========================================

function openManualGrouping() {
const selector = document.getElementById('commSheetSelector');
const url = selector.value;
if(!url || url.includes("Select") || url.includes("Loading") || url.includes("Error")) return alert("Select an event first");

currentGroupingSheetUrl = url;
document.getElementById('navContextTitle').innerText = "Manual Group: " + selector.options[selector.selectedIndex].text;

currentGroupingFilter = "ALL";
currentGroupingSearch = "";
document.getElementById('groupingFilterSelect').value = "ALL";
document.getElementById('groupingSearchInput').value = "";

showView('manual-grouping');
loadGroupingData();
}

function loadGroupingData() {
const overlay = document.getElementById('groupingLoadingOverlay');
overlay.classList.remove('hidden');

apiCall('fetchManualPairingData', { sheetUrl: currentGroupingSheetUrl }).then(res => {
overlay.classList.add('hidden');
if (res.success) {
groupingData = res.data;
renderGroupingList();
startGroupingPolling();
} else {
alert("Error: " + res.message);
showView('comm');
}
});
}

function changeGroupingFilter() {
currentGroupingFilter = document.getElementById('groupingFilterSelect').value;
renderGroupingList();
}

function changeGroupingSearch() {
currentGroupingSearch = document.getElementById('groupingSearchInput').value.toLowerCase().trim();
renderGroupingList();
}

function renderGroupingList() {
const container = document.getElementById('groupingList');

// Remove Volunteers from Manual Grouping - strictly Trainees now
let activeTrainees = (groupingData.trainees || [])
.filter(t => t.attending === 'y' && !t.isGoneHome);

let groupSet = new Set();
activeTrainees.forEach(item => {
let g = String(item.group || "").trim();
if (g !== "") groupSet.add(g);
});

let groups = Array.from(groupSet).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));

const filterSelect = document.getElementById('groupingFilterSelect');
let filterHtml = `<option value="ALL">All Groups</option><option value="UNASSIGNED">Unassigned</option>`;
groups.forEach(g => {
filterHtml += `<option value="${g}">Group ${g}</option>`;
});
filterSelect.innerHTML = filterHtml;

if (["ALL", "UNASSIGNED", ...groups].includes(currentGroupingFilter)) {
filterSelect.value = currentGroupingFilter;
} else {
currentGroupingFilter = "ALL";
filterSelect.value = "ALL";
}

if (currentGroupingSearch) {
activeTrainees = activeTrainees.filter(item => {
 const nameMatch = item.name.toLowerCase().includes(currentGroupingSearch);
 const volMatch = item.volPaired && item.volPaired.toLowerCase().includes(currentGroupingSearch);
 const groupMatch = String(item.group || "").toLowerCase().includes(currentGroupingSearch);
 return nameMatch || volMatch || groupMatch;
});
}

if (currentGroupingFilter === "UNASSIGNED") {
activeTrainees = activeTrainees.filter(item => String(item.group || "").trim() === "");
} else if (currentGroupingFilter !== "ALL") {
activeTrainees = activeTrainees.filter(item => String(item.group || "").trim() === currentGroupingFilter);
}

activeTrainees.sort((a, b) => {
const groupA = String(a.group || "").trim();
const groupB = String(b.group || "").trim();

if (groupA === "" && groupB !== "") return -1;
if (groupA !== "" && groupB === "") return 1;

if (groupA !== groupB) {
 const numA = parseInt(groupA);
 const numB = parseInt(groupB);
 if (!isNaN(numA) && !isNaN(numB)) {
     return numA - numB;
 }
 return groupA.localeCompare(groupB, undefined, {numeric: true});
}

return a.name.localeCompare(b.name);
});

let html = '';

if (activeTrainees.length === 0) {
html = `<div class="p-4 text-center text-gray-500 dark:text-gray-400 font-bold text-xs italic">No trainees match the current filters.</div>`;
} else {
activeTrainees.forEach(item => {
 const groupStr = String(item.group || "").trim();
 const groupBadgeClass = groupStr !== "" 
     ? `bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-800` 
     : `bg-red-50 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-900/50`;
     
 const roleBadge = `<span class="bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800 px-1 py-0.5 rounded text-[8px] uppercase font-black tracking-wider shadow-sm">Trainee</span>`;

 let subInfo = '';
 if (item.volPaired) {
     subInfo = `<div class="text-[10px] text-teal-600 dark:text-teal-400 font-bold line-clamp-2 mt-1"><i class="fa-solid fa-handshake-angle opacity-80 mr-1"></i>${item.volPaired}</div>`;
 }
 
 // 1-1 Pairing Star logic
 let starBadge = '';
 if (item.extra && item.extra.t_one_on_one) {
     const oneOnOneRaw = String(item.extra.t_one_on_one).trim().toLowerCase();
     if (oneOnOneRaw === 'yes' || oneOnOneRaw === 'y' || oneOnOneRaw === 'true') {
         starBadge = `<i class="fa-solid fa-star text-yellow-500 shrink-0 text-xs ml-1" title="1-1 Pairing Required"></i>`;
     }
 }
 
 // Remarks Badge logic
 let remarksBadge = '';
 let remarkContent = null;
 if (item.extra && item.extra.remark) {
     remarkContent = String(item.extra.remark).trim();
 }
 if (remarkContent) {
     remarksBadge = `<i class="fa-solid fa-note-sticky text-yellow-500 dark:text-yellow-400 shrink-0 text-xs ml-1 cursor-help" title="${remarkContent.replace(/"/g, '&quot;')}"></i>`;
 }

 const safeName = item.name.replace(/'/g, "\\'");
 
 html += `
 <div class="grouping-card bg-white dark:bg-zinc-900 p-3 rounded-lg border border-gray-200 dark:border-zinc-700 shadow-sm cursor-pointer hover:border-orange-500 transition active:scale-[0.98] select-none" data-name="${safeName}" onclick="openQuickGroupModal('${safeName}')">
     <div class="flex justify-between items-start w-full gap-2">
         <div class="flex flex-col gap-1 min-w-0 flex-1">
             <div class="flex items-center gap-2">
                 <div class="flex items-center gap-1 min-w-0">
                     <span class="font-extrabold text-xs md:text-sm text-gray-900 dark:text-white leading-tight truncate">${item.name}</span>
                     ${starBadge}
                     ${remarksBadge}
                 </div>
                 ${roleBadge}
             </div>
             ${subInfo}
         </div>
         <div class="shrink-0 flex items-center justify-end">
             <span class="${groupBadgeClass} border px-2 py-0.5 rounded font-black text-[10px] uppercase shadow-sm">${groupStr ? `Grp ${groupStr}` : 'Unassigned'}</span>
         </div>
     </div>
 </div>
 `;
});
}

container.innerHTML = html;

// Bind Long Press globally to items
document.querySelectorAll('.grouping-card').forEach(el => {
 uiBindLongPress(el, () => {
     const name = el.getAttribute('data-name');
     const p = (groupingData.trainees || []).find(x => x.name.replace(/'/g, "\\'") === name);
     if (p) showPersonInfo(p);
 });
});
}

// ==========================================
// QUICK GROUP MODAL (Vertical List Logic)
// ==========================================

function openQuickGroupModal(name) {
currentGroupingTargetName = name;

const title = document.getElementById('quickGroupModalTitle');
title.innerHTML = `Assign <span class="text-orange-500">${name}</span>`;

const grid = document.getElementById('quickGroupGrid');

let currentGroup = "";
const t = groupingData.trainees.find(x => x.name === name);
if(t) currentGroup = String(t.group || "").trim();

let activeTrainees = (groupingData.trainees || []).filter(tr => tr.attending === 'y');

let highest = 0;
let groupSet = new Set();

activeTrainees.forEach(tr => {
const g = String(tr.group || "").trim();
if (g !== "") {
 groupSet.add(g);
 const num = parseInt(g);
 if (!isNaN(num) && num > highest) highest = num;
}
});

let groups = Array.from(groupSet).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));

let gridHtml = '';
groups.forEach(g => {
const isCurrent = g === currentGroup;
gridHtml += `
<button onclick="handleGroupSelection('${g}')" class="py-3 px-2 rounded-lg border flex flex-col items-center justify-center gap-1 transition ${isCurrent ? 'bg-orange-100 border-orange-500 text-orange-800 dark:bg-orange-900/50 dark:border-orange-500 dark:text-orange-200' : 'bg-gray-50 border-gray-300 text-gray-700 hover:bg-orange-50 hover:border-orange-300 dark:bg-black dark:border-zinc-700 dark:text-gray-300 dark:hover:bg-zinc-800'}">
 <span class="text-[10px] font-bold uppercase opacity-80 leading-none">Group</span>
 <span class="text-lg font-black leading-none">${g}</span>
</button>
`;
});

grid.innerHTML = gridHtml || `<div class="col-span-3 text-center text-xs text-gray-500 p-2">No groups exist yet.</div>`;

document.getElementById('quickGroupModal').classList.remove('hidden');
}

function closeQuickGroupModal() {
document.getElementById('quickGroupModal').classList.add('hidden');
}

function handleNewGroupSelection() {
const newGroup = prompt("Enter new group name/number:");
if (newGroup !== null && newGroup.trim() !== "") {
 handleGroupSelection(newGroup.trim());
}
}

function triggerGroupingPulse(namesArray, isAssigned) {
setTimeout(() => {
    requestAnimationFrame(() => {
        namesArray.forEach(name => {
            const safeName = name.replace(/'/g, "\\'");
            const card = document.querySelector(`.grouping-card[data-name="${safeName}"]`);
            if (card) {
                const container = document.getElementById('groupingList');
                if (container) {
                    const containerRect = container.getBoundingClientRect();
                    const cardRect = card.getBoundingClientRect();
                    
                    if (cardRect.height > 0) {
                        if (cardRect.top < containerRect.top || cardRect.bottom > containerRect.bottom) {
                            const scrollTop = container.scrollTop + (cardRect.top - containerRect.top) - (containerRect.height / 2) + (cardRect.height / 2);
                            container.scrollTo({
                                top: scrollTop,
                                behavior: 'smooth'
                            });
                        }
                    }
                }
                
                const pulseClass = isAssigned ? 'pulse-green' : 'pulse-red';
                card.classList.add(pulseClass);
                setTimeout(() => {
                    card.classList.remove(pulseClass);
                }, 800);
            }
        });
    });
}, 150);
}

function handleGroupSelection(targetGroupRaw) {
const targetGroup = targetGroupRaw === "UNASSIGNED" ? "" : targetGroupRaw;
const name = currentGroupingTargetName;

lastGroupingLocalChange = Date.now();

let trainee = groupingData.trainees.find(t => t.name === name);
if (!trainee) { closeQuickGroupModal(); return; }

const currentGroup = String(trainee.group || "").trim();
if (currentGroup === targetGroup) { closeQuickGroupModal(); return; }

const traineesToMove = new Set([name]);

if (targetGroup !== "" && trainee.volPaired) {
let changed = true;
while(changed) {
 changed = false;
 
 let aggregateVols = new Set();
 traineesToMove.forEach(tName => {
     const t = groupingData.trainees.find(x => x.name === tName);
     if (t && t.volPaired) {
         const vols = t.volPaired.split(/[,|\n]+/).map(v => v.trim().toLowerCase()).filter(v => v);
         vols.forEach(v => aggregateVols.add(v));
     }
 });
 
 groupingData.trainees.forEach(otherT => {
     if (traineesToMove.has(otherT.name) || !otherT.volPaired) return;
     
     const otherVols = otherT.volPaired.split(/[,|\n]+/).map(v => v.trim().toLowerCase()).filter(v => v);
     const hasSharedVol = otherVols.some(v => aggregateVols.has(v));
     
     if (hasSharedVol) {
         traineesToMove.add(otherT.name);
         changed = true; 
     }
 });
}
}

traineesToMove.forEach(tName => {
let t = groupingData.trainees.find(x => x.name === tName);
if(t) {
 t.group = targetGroup;
 const updateIndex = pendingGroupingUpdates.findIndex(u => u.name === tName && u.role === 'TRAINEE');
 if (updateIndex > -1) {
     pendingGroupingUpdates[updateIndex].group = targetGroup;
 } else {
     pendingGroupingUpdates.push({ role: 'TRAINEE', name: tName, group: targetGroup });
 }
}
});

if (traineesToMove.size > 1 && targetGroup !== "") {
showFlashMessage('groupingGlobalStatus', `Auto-Grouped ${traineesToMove.size} trainees together due to shared volunteers.`, 'success');
}

renderGroupingList();

const isAssigned = targetGroup !== "";
triggerGroupingPulse(Array.from(traineesToMove), isAssigned);

triggerGroupingSync();
closeQuickGroupModal();
}

function setGroupingSyncButtonState(state) {
const btn = document.getElementById('btn-sync-manual-grouping');
if(!btn) return;
const textSpan = btn.querySelector('.btn-text'); const spinner = btn.querySelector('.btn-spinner');

btn.className = "text-[10px] md:text-xs px-1.5 py-1 rounded font-bold transition flex items-center justify-center border shadow-sm focus:outline-none shrink-0"; 
spinner.className = "fa-solid fa-circle-notch fa-spin btn-spinner ml-1 hidden"; 

if (state === 'loading' || state === 'saving') { 
btn.classList.add('bg-yellow-50', 'text-yellow-700', 'border-yellow-200', 'dark:bg-yellow-900/30', 'dark:text-yellow-400', 'dark:border-yellow-800'); 
textSpan.textContent = state === 'loading' ? "Loading..." : "Saving..."; 
spinner.classList.remove('hidden'); 
} else if (state === 'saved') { 
btn.classList.add('bg-green-50', 'text-green-700', 'border-green-200', 'dark:bg-green-900/30', 'dark:text-green-400', 'dark:border-green-800'); 
textSpan.textContent = "Saved"; 
setTimeout(() => {
if (pendingGroupingUpdates.length === 0) {
   btn.className = "text-[10px] md:text-xs px-1.5 py-1 rounded font-bold transition flex items-center border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-700 dark:text-gray-300 shadow-sm focus:outline-none shrink-0";
   textSpan.textContent = "Saved";
}
}, 2000);
} else if (state === 'error') { 
btn.classList.add('bg-red-50', 'text-red-700', 'border-red-200', 'dark:bg-red-900/30', 'dark:text-red-400', 'dark:border-red-800'); 
textSpan.textContent = "Save Failed"; 
}
}

function triggerGroupingSync() {
setGroupingSyncButtonState('saving');
if (groupingSyncTimeout) clearTimeout(groupingSyncTimeout);
groupingSyncTimeout = setTimeout(() => {
executeGroupingSync();
}, 800); 
}

async function executeGroupingSync() {
if (pendingGroupingUpdates.length === 0) return;

isGroupingSyncing = true;
setGroupingSyncButtonState('saving');

const updatesToSync = [...pendingGroupingUpdates];
pendingGroupingUpdates = [];

try {
const res = await apiCall('syncManualGroupingUpdates', { sheetUrl: currentGroupingSheetUrl, updates: updatesToSync });

if (res.success) {
setGroupingSyncButtonState('saved');
} else {
throw new Error(res.message);
}
} catch(e) {
console.error(e);
setGroupingSyncButtonState('error');
// Push back failed updates
updatesToSync.forEach(u => {
const idx = pendingGroupingUpdates.findIndex(p => p.name === u.name && p.role === u.role);
if (idx === -1) pendingGroupingUpdates.push(u);
});
} finally {
isGroupingSyncing = false;
}
}

function startGroupingPolling() {
if (groupingPollInterval) clearInterval(groupingPollInterval);

groupingPollInterval = setInterval(async () => {
const view = document.getElementById('view-manual-grouping');
if(!view || view.classList.contains('hidden') || isGroupingSyncing || (dndState.el || dndState.isDragging)) return;

if (pendingGroupingUpdates.length > 0) return;

const fetchStartTime = Date.now();

try {
const res = await apiCall('fetchManualPairingData', { sheetUrl: currentGroupingSheetUrl });
if(res.success && !isGroupingSyncing && pendingGroupingUpdates.length === 0) {
   if (lastGroupingLocalChange > fetchStartTime) return;

   const newDataStr = JSON.stringify(res.data);
   const oldDataStr = JSON.stringify(groupingData);
   
   if (newDataStr !== oldDataStr) {
       groupingData = res.data;
       renderGroupingList();
   }
}
} catch(e) { }
}, 8000);
}

async function manualSyncGrouping() {
if (pendingGroupingUpdates.length > 0) {
await executeGroupingSync();
}

setGroupingSyncButtonState('loading');
const overlay = document.getElementById('groupingLoadingOverlay');
overlay.classList.remove('hidden');

const fetchStartTime = Date.now();

try {
const res = await apiCall('fetchManualPairingData', { sheetUrl: currentGroupingSheetUrl });
overlay.classList.add('hidden');
if (res.success) {
if (lastGroupingLocalChange > fetchStartTime) return;

groupingData = res.data;
renderGroupingList();
setGroupingSyncButtonState('saved');
} else {
setGroupingSyncButtonState('error');
}
} catch (e) {
overlay.classList.add('hidden');
setGroupingSyncButtonState('error');
}
}

// ==========================================
// ASSIGN ICs MODAL LOGIC (Groups, Meet, Dismiss)
// ==========================================

function openAssignICModal(sheetUrl) {
if(!sheetUrl || sheetUrl.includes("Select")) return alert("Select an event first");

currentGroupingSheetUrl = sheetUrl;
showOverlay('loading', 'Loading Roles...');

apiCall('fetchManualPairingData', { sheetUrl: sheetUrl }).then(res => {
   closeOverlay();
   if (res.success) {
       groupingData = res.data;
       renderAssignICModal();
       document.getElementById('assignICModal').classList.remove('hidden');
   } else {
       alert("Error: " + res.message);
   }
});
}

function closeAssignICModal() {
document.getElementById('assignICModal').classList.add('hidden');
if (pendingGroupingUpdates.length > 0) {
   triggerGroupingSync();
}
}

window.toggleAssignICDropdown = function(id, e) {
if(e) e.stopPropagation();
const el = document.getElementById(id);
const isHidden = el.classList.contains('hidden');
document.querySelectorAll('.assign-ic-dropdown-list').forEach(list => list.classList.add('hidden'));
if(isHidden) el.classList.remove('hidden');
};

document.addEventListener('click', function(e) {
if(!e.target.closest('.assign-ic-dropdown-list') && !e.target.closest('button[onclick^="toggleAssignICDropdown"]')) {
   document.querySelectorAll('.assign-ic-dropdown-list').forEach(list => list.classList.add('hidden'));
}
});

function generateCustomDropdownHtml(type, targetId, label, options, currentICName) {
const safeTarget = targetId.replace(/'/g, "\\'");
const dropdownId = `dropdown-${type}-${safeTarget.replace(/[^a-zA-Z0-9]/g, '')}`;

let listHtml = `<div class="p-2 border-b border-gray-100 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-700 cursor-pointer transition-colors" onclick="handleAssignICChange('${type}', '${safeTarget}', '')">
   <div class="font-bold text-sm text-gray-500">-- No IC Assigned --</div>
</div>`;

if (options.length === 0) {
   listHtml += `<div class="p-3 text-xs text-gray-400 italic text-center">No eligible volunteers active.</div>`;
} else {
   options.forEach(v => {
       const remark = (v.extra && v.extra.remark) ? `<div class="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 whitespace-normal leading-tight break-words"><i class="fa-solid fa-note-sticky text-yellow-500 mr-1"></i>${v.extra.remark}</div>` : '';
       const isSelected = (v.name === currentICName);
       const bgClass = isSelected ? 'bg-blue-50 dark:bg-blue-900/20 border-l-2 border-blue-500' : 'hover:bg-gray-50 dark:hover:bg-zinc-700 border-l-2 border-transparent';
       
       listHtml += `<div class="p-2 border-b border-gray-100 dark:border-zinc-800 ${bgClass} cursor-pointer transition-colors" onclick="handleAssignICChange('${type}', '${safeTarget}', '${v.name.replace(/'/g, "\\'")}')">
           <div class="font-bold text-sm text-gray-900 dark:text-white flex justify-between items-center">
               <span>${v.name}</span>
               ${isSelected ? '<i class="fa-solid fa-check text-blue-500 text-xs"></i>' : ''}
           </div>
           ${remark}
       </div>`;
   });
}

const displayLabel = currentICName || "-- No IC Assigned --";

return `
<div class="bg-gray-50 dark:bg-zinc-800/50 p-3 md:p-4 rounded-xl border border-gray-200 dark:border-zinc-700 relative">
   <label class="block text-xs font-black text-gray-900 dark:text-white mb-2 uppercase tracking-wide">${label}</label>
   <div class="relative">
       <button type="button" onclick="toggleAssignICDropdown('${dropdownId}', event)" class="w-full bg-white dark:bg-black border border-gray-300 dark:border-zinc-600 rounded-lg p-2.5 text-sm text-gray-900 dark:text-white shadow-sm focus:outline-none focus:border-blue-500 flex justify-between items-center">
           <span class="truncate">${displayLabel}</span>
           <i class="fa-solid fa-chevron-down text-xs text-gray-400"></i>
       </button>
       <div id="${dropdownId}" class="assign-ic-dropdown-list hidden absolute z-50 w-full mt-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-xl max-h-60 overflow-y-auto custom-scrollbar text-left">
           ${listHtml}
       </div>
   </div>
</div>
`;
}

function renderAssignICModal() {
const container = document.getElementById('assignICContainer');
let html = '<div class="space-y-6">';

const volLookup = new Map();
(groupingData.volunteers || []).forEach(v => volLookup.set(v.name.toLowerCase(), v));

// --- 1. GROUP ICs ---
let activeTrainees = (groupingData.trainees || []).filter(t => t.attending === 'y' && !t.isGoneHome && String(t.group).trim() !== "");
let allGroups = new Set();
activeTrainees.forEach(t => allGroups.add(String(t.group).trim()));
let sortedGroups = Array.from(allGroups).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));

if (sortedGroups.length > 0) {
   html += `<div><h4 class="font-black text-gray-900 dark:text-white border-b border-gray-200 dark:border-zinc-700 pb-2 mb-3"><i class="fa-solid fa-users text-orange-500 mr-2"></i>Group ICs</h4><div class="space-y-3">`;
   sortedGroups.forEach(g => {
       let tList = activeTrainees.filter(t => String(t.group).trim() === g);
       let groupVolKeys = new Set();
       tList.forEach(t => {
           if (t.volPaired) {
               const vols = t.volPaired.split(/[,|\n]+/).map(v => v.trim()).filter(v => v);
               vols.forEach(v => groupVolKeys.add(v.toLowerCase()));
           }
       });
       
       let options = [];
       let currentICName = "";
       Array.from(groupVolKeys).sort().forEach(vKey => {
           const vObj = volLookup.get(vKey);
           if (vObj) {
               if (vObj.groupIC) currentICName = vObj.name;
               options.push(vObj);
           }
       });
       html += generateCustomDropdownHtml('group', g, `Group ${g} IC`, options, currentICName);
   });
   html += `</div></div>`;
} else {
   html += `<div><h4 class="font-black text-gray-900 dark:text-white border-b border-gray-200 dark:border-zinc-700 pb-2 mb-3"><i class="fa-solid fa-users text-orange-500 mr-2"></i>Group ICs</h4>
   <p class="text-xs text-gray-500 italic text-center py-2">No groups assigned yet.</p></div>`;
}

// --- 2. MEETING ICs ---
let meetingLocs = groupingData.meetingLocs || [];
if (meetingLocs.length > 0) {
   html += `<div><h4 class="font-black text-gray-900 dark:text-white border-b border-gray-200 dark:border-zinc-700 pb-2 mb-3"><i class="fa-solid fa-location-dot text-blue-500 mr-2"></i>Meeting ICs</h4><div class="space-y-3">`;
   meetingLocs.forEach(loc => {
       let options = [];
       let currentICName = "";
       (groupingData.volunteers || []).forEach(v => {
           if(v.extra && v.extra.v_meet && v.extra.v_meet.toLowerCase() === loc.toLowerCase()) {
               if(v.meetIC) currentICName = v.name;
               options.push(v);
           }
       });
       options.sort((a,b) => a.name.localeCompare(b.name));
       html += generateCustomDropdownHtml('meet', loc, `Meet: ${loc}`, options, currentICName);
   });
   html += `</div></div>`;
}

// --- 3. DISMISSAL ICs ---
let dismissalLocs = groupingData.dismissalLocs || [];
if (dismissalLocs.length > 0) {
   html += `<div><h4 class="font-black text-gray-900 dark:text-white border-b border-gray-200 dark:border-zinc-700 pb-2 mb-3"><i class="fa-solid fa-flag-checkered text-purple-500 mr-2"></i>Dismissal ICs</h4><div class="space-y-3">`;
   dismissalLocs.forEach(loc => {
       let options = [];
       let currentICName = "";
       (groupingData.volunteers || []).forEach(v => {
           if(v.extra && v.extra.v_dismiss && v.extra.v_dismiss.toLowerCase() === loc.toLowerCase()) {
               if(v.dismissIC) currentICName = v.name;
               options.push(v);
           }
       });
       options.sort((a,b) => a.name.localeCompare(b.name));
       html += generateCustomDropdownHtml('dismiss', loc, `Dismiss: ${loc}`, options, currentICName);
   });
   html += `</div></div>`;
}

html += '</div>';
container.innerHTML = html;
}

function handleAssignICChange(type, target, newVolName) {
lastGroupingLocalChange = Date.now();
document.querySelectorAll('.assign-ic-dropdown-list').forEach(list => list.classList.add('hidden'));

let groupVolKeys = new Set();

if (type === 'group') {
   let tList = (groupingData.trainees || []).filter(t => t.attending === 'y' && !t.isGoneHome && String(t.group).trim() === String(target));
   tList.forEach(t => {
       if (t.volPaired) {
           t.volPaired.split(/[,|\n]+/).map(v => v.trim()).filter(v => v).forEach(v => groupVolKeys.add(v.toLowerCase()));
       }
   });
} else if (type === 'meet') {
   (groupingData.volunteers || []).forEach(v => {
       if (v.extra && v.extra.v_meet && v.extra.v_meet.toLowerCase() === target.toLowerCase()) {
           groupVolKeys.add(v.name.toLowerCase());
       }
   });
} else if (type === 'dismiss') {
   (groupingData.volunteers || []).forEach(v => {
       if (v.extra && v.extra.v_dismiss && v.extra.v_dismiss.toLowerCase() === target.toLowerCase()) {
           groupVolKeys.add(v.name.toLowerCase());
       }
   });
}

const newVolKey = newVolName ? newVolName.toLowerCase() : null;

(groupingData.volunteers || []).forEach(v => {
   const vKey = v.name.toLowerCase();
   
   if (groupVolKeys.has(vKey)) {
       const shouldBeIC = (vKey === newVolKey);
       
       let changed = false;
       if (type === 'group' && v.groupIC !== shouldBeIC) { v.groupIC = shouldBeIC; changed = true; }
       else if (type === 'meet' && v.meetIC !== shouldBeIC) { v.meetIC = shouldBeIC; changed = true; }
       else if (type === 'dismiss' && v.dismissIC !== shouldBeIC) { v.dismissIC = shouldBeIC; changed = true; }
       
       if (changed) {
           let updateIndex = pendingGroupingUpdates.findIndex(u => u.name === v.name && u.role === 'VOLUNTEER');
           if (updateIndex === -1) {
               pendingGroupingUpdates.push({ role: 'VOLUNTEER', name: v.name });
               updateIndex = pendingGroupingUpdates.length - 1;
           }
           if (type === 'group') pendingGroupingUpdates[updateIndex].groupIC = shouldBeIC;
           if (type === 'meet') pendingGroupingUpdates[updateIndex].meetIC = shouldBeIC;
           if (type === 'dismiss') pendingGroupingUpdates[updateIndex].dismissIC = shouldBeIC;
       }
   }
});

renderAssignICModal(); // Re-render instantly
triggerGroupingSync();
}

// ==========================================
// EXPORT TABLE LOGIC
// ==========================================

function openTableExportModal() {
buildExportTable();
// Reset preview area
const preview = document.getElementById('exportTablePreview');
if(preview) preview.innerHTML = '';

document.getElementById('exportTableContainer').classList.remove('hidden');
document.getElementById('exportTableModal').classList.remove('hidden');
}

function closeTableExportModal() {
document.getElementById('exportTableModal').classList.add('hidden');
}

function buildExportTable() {
const container = document.getElementById('exportTableContainer');
// Strip min-w-max dynamically and enforce full width for mobile screen wrap
container.classList.remove('min-w-max');
container.classList.add('w-full');

let allGroups = new Set();
groupingData.trainees.forEach(t => {
  if (t.attending === 'y' && !t.isGoneHome && String(t.group).trim() !== "") {
      allGroups.add(String(t.group).trim());
  }
});

let sortedGroups = Array.from(allGroups).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));

let html = `
<table class="w-full text-left border-collapse text-[9px] md:text-xs text-gray-800" style="font-family: Arial, sans-serif; border: 1px solid #333; table-layout: fixed; width: 100%; word-wrap: break-word;">
  <thead>
      <tr style="background-color: #333; color: #fff;">
          <th style="padding: 3px; border: 1px solid #555; width: 30%; vertical-align: middle;">Volunteer</th>
          <th style="padding: 3px; border: 1px solid #555; width: 30%; vertical-align: middle;">Trainee(s)</th>
          <th style="padding: 3px; border: 1px solid #555; width: 10%; text-align: center; vertical-align: middle;">Grp</th>
          <th style="padding: 3px; border: 1px solid #555; width: 30%; vertical-align: middle;">Remarks</th>
      </tr>
  </thead>
  <tbody>
`;

if (sortedGroups.length === 0) {
  html += `<tr><td colspan="4" style="padding: 10px; text-align: center; font-style: italic;">No groups assigned yet.</td></tr>`;
}

const volLookup = new Map();
groupingData.volunteers.forEach(v => {
  volLookup.set(v.name.toLowerCase(), v);
});

sortedGroups.forEach((g, index) => {
  const bgColor = EXPORT_COLORS[index % EXPORT_COLORS.length];
  
  let tList = groupingData.trainees.filter(t => t.attending === 'y' && !t.isGoneHome && String(t.group).trim() === g);
  
  let volMap = new Map();
  let unpairedTrainees = [];
  
  tList.forEach(t => {
      const remarks = t.extra?.remarks || t.extra?.remark || '';
      if (t.volPaired) {
          const vols = t.volPaired.split(/[,|\n]+/).map(v => v.trim()).filter(v => v);
          vols.forEach(v => {
              const vKey = v.toLowerCase();
              if (!volMap.has(vKey)) {
                  const vObj = volLookup.get(vKey);
                  volMap.set(vKey, {
                      name: vObj ? vObj.name : v, 
                      isGroupIC: vObj ? vObj.groupIC === true : false,
                      isMeetIC: vObj ? vObj.meetIC === true : false,
                      isDismissIC: vObj ? vObj.dismissIC === true : false,
                      volRemark: vObj ? (vObj.extra?.remarks || vObj.extra?.remark || '') : '',
                      trainees: [],
                      remarks: []
                  });
              }
              const vData = volMap.get(vKey);
              vData.trainees.push(t.name);
              if (remarks) vData.remarks.push(`<strong>[Trn] ${t.name}:</strong> ${remarks}`);
          });
      } else {
          unpairedTrainees.push({ name: t.name, remarks: remarks });
      }
  });
  
  let rows = Array.from(volMap.values());
  
  rows.sort((a, b) => {
      const aIsIC = a.isGroupIC || a.isMeetIC || a.isDismissIC;
      const bIsIC = b.isGroupIC || b.isMeetIC || b.isDismissIC;
      if (aIsIC && !bIsIC) return -1;
      if (!aIsIC && bIsIC) return 1;
      return a.name.localeCompare(b.name);
  });
  
  if (rows.length === 0 && unpairedTrainees.length === 0) {
      html += `<tr style="background-color: ${bgColor};">
          <td colspan="2" style="padding: 3px; border: 1px solid #ccc; font-style: italic; vertical-align: middle;">No assignments</td>
          <td style="padding: 3px; border: 1px solid #ccc; text-align: center; font-weight: bold; vertical-align: middle;">${g}</td>
          <td style="padding: 3px; border: 1px solid #ccc; vertical-align: middle;"></td>
      </tr>`;
  }
  
  rows.forEach(r => {
      let volDisplay = `<span style="font-weight: bold;">${r.name}</span>`;
      if (r.isGroupIC) volDisplay += `<br><strong style="color: #0369a1; font-size: 0.9em; display:inline-block; margin-top:2px;">(Grp ${g} IC)</strong>`;
      if (r.isMeetIC) volDisplay += `<br><strong style="color: #047857; font-size: 0.9em; display:inline-block; margin-top:2px;">(Meeting IC)</strong>`;
      if (r.isDismissIC) volDisplay += `<br><strong style="color: #6d28d9; font-size: 0.9em; display:inline-block; margin-top:2px;">(Dismissal IC)</strong>`;
      
      let tDisplay = r.trainees.length > 0 ? r.trainees.join('<br>') : '-';
      
      let allRemarks = [];
      if (r.volRemark) allRemarks.push(`<strong>[Vol] ${r.name}:</strong> ${r.volRemark}`);
      if (r.remarks.length > 0) allRemarks = allRemarks.concat(r.remarks);
      let rDisplay = allRemarks.join('<br><br>');
      
      html += `<tr style="background-color: ${bgColor};">
          <td style="padding: 3px; border: 1px solid #ccc; vertical-align: middle;">${volDisplay}</td>
          <td style="padding: 3px; border: 1px solid #ccc; vertical-align: middle;">${tDisplay}</td>
          <td style="padding: 3px; border: 1px solid #ccc; text-align: center; font-weight: bold; vertical-align: middle;">${g}</td>
          <td contenteditable="true" style="padding: 3px; border: 1px solid #ccc; outline: none; transition: background 0.2s; vertical-align: middle;" onfocus="this.style.backgroundColor='#fff'" onblur="this.style.backgroundColor='transparent'">${rDisplay}</td>
      </tr>`;
  });
  
  unpairedTrainees.forEach(ut => {
      let rDisplay = ut.remarks ? `<strong>[Trn] ${ut.name}:</strong> ${ut.remarks}` : '';
      html += `<tr style="background-color: ${bgColor};">
          <td style="padding: 3px; border: 1px solid #ccc; font-weight: bold; color: #dc2626; text-align: center; vertical-align: middle;">-</td>
          <td style="padding: 3px; border: 1px solid #ccc; vertical-align: middle;">${ut.name}</td>
          <td style="padding: 3px; border: 1px solid #ccc; text-align: center; font-weight: bold; vertical-align: middle;">${g}</td>
          <td contenteditable="true" style="padding: 3px; border: 1px solid #ccc; outline: none; transition: background 0.2s; vertical-align: middle;" onfocus="this.style.backgroundColor='#fff'" onblur="this.style.backgroundColor='transparent'">${rDisplay}</td>
      </tr>`;
  });
});

html += `</tbody></table>`;
container.innerHTML = html;
}

let generatedImageBlob = null; // Store blob to share via Web Share API

async function shareExportTable() {
const container = document.getElementById('exportTableContainer');
const btn = document.getElementById('shareTableBtn');
const preview = document.getElementById('exportTablePreview');
if(!container || !btn || !preview) return;

const originalText = btn.innerHTML;
btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
btn.disabled = true;

container.querySelectorAll('[contenteditable]').forEach(el => {
  el.style.outline = 'none';
});

try {
  if (typeof html2canvas === 'undefined') throw new Error("html2canvas not loaded");
  
  const canvas = await html2canvas(container, {
      scale: 3, // High quality resolution
      backgroundColor: '#ffffff',
      useCORS: true
  });
  
  const dataUrl = canvas.toDataURL('image/png');
  
  // Hide actual table, show image preview
  container.classList.add('hidden');
  preview.innerHTML = `<p class="text-xs text-green-600 dark:text-green-400 font-bold mb-2 text-center">Image ready! Long press to save or share directly.</p><img src="${dataUrl}" class="w-full h-auto shadow-md rounded border border-gray-200 dark:border-zinc-700 mx-auto" />`;
  
  // Convert Base64 to Blob for Native Sharing
  generatedImageBlob = await (await fetch(dataUrl)).blob();
  
  // Transform button to Share Via Apps
  btn.innerHTML = '<i class="fa-solid fa-share-nodes"></i> Share via Apps';
  btn.onclick = executeNativeShare;
  btn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
  btn.classList.add('bg-green-600', 'hover:bg-green-700');

  // Async Upload to Drive without blocking user
  if (currentGroupingSheetUrl) {
      apiCall('uploadExportTable', {
          sheetUrl: currentGroupingSheetUrl,
          imageBase64: dataUrl
      }).then(res => {
          if(res.success) {
              showFlashMessage('groupingGlobalStatus', "Backup saved to Drive.", 'success');
          }
      });
  }

} catch (e) {
  console.error(e);
  alert("Failed to share table: " + e.message);
  btn.innerHTML = originalText;
} finally {
  btn.disabled = false;
}
}

async function executeNativeShare() {
if (!generatedImageBlob) return;

const file = new File([generatedImageBlob], 'outing-groups.png', { type: 'image/png' });

try {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
          title: 'Outing Groups',
          files: [file]
      });
  } else {
      // Fallback to clipboard if share not supported
      if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': generatedImageBlob })]);
          showFlashMessage('groupingGlobalStatus', "Table copied to clipboard!", 'success');
      } else {
          alert("Sharing not supported on this device. Long press the image to save it.");
      }
  }
} catch (e) {
  console.log('Share canceled or failed', e);
}
}