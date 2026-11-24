require("./patch_logger.js");
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./backend/config.js');
const NodeCache = require('node-cache');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const port = 3000;

const _fetch = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

// Authoritative in-memory state cache (60s standard TTL, actively patched on mutations)
const cache = new NodeCache({ stdTTL: 60, checkperiod: 15, useClones: false });

// In-flight request tracker to collapse duplicate concurrent reads
const inFlightRequests = new Map();

// Track pending mutations per sheetUrl that have been applied in-memory on the server
// but are still queued or in-flight to Google Apps Script (GAS)
// Map<sheetUrl, Array<{ id, type, payload, timestamp }>>
const pendingServerMutations = new Map();
const lastLiveWsMutationAt = new Map();
let mutationCounter = 1;

function touchLiveWsMutation(sheetUrl) {
    if (sheetUrl) lastLiveWsMutationAt.set(sheetUrl, Date.now());
}

function addPendingServerMutation(sheetUrl, type, payload) {
    if (!sheetUrl) return null;
    const id = mutationCounter++;
    if (!pendingServerMutations.has(sheetUrl)) {
        pendingServerMutations.set(sheetUrl, []);
    }
    pendingServerMutations.get(sheetUrl).push({
        id,
        type,
        payload,
        timestamp: Date.now()
    });
    return id;
}

function removePendingServerMutation(sheetUrl, id) {
    if (!sheetUrl || !id || !pendingServerMutations.has(sheetUrl)) return;
    const list = pendingServerMutations.get(sheetUrl).filter(m => m.id !== id);
    if (list.length === 0) {
        pendingServerMutations.delete(sheetUrl);
    } else {
        pendingServerMutations.set(sheetUrl, list);
    }
}

// Concurrency queue for write requests to avoid hitting GAS limits and preserve strict FIFO write order
class AsyncQueue {
    constructor(concurrency = 1) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    resolve(await task());
                } catch (e) {
                    reject(e);
                }
            });
            this.process();
        });
    }

    async process() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;
        this.running++;
        const task = this.queue.shift();
        try {
            await task();
        } finally {
            this.running--;
            this.process();
        }
    }

    get isBusy() {
        return this.running > 0 || this.queue.length > 0;
    }
}

const writeQueue = new AsyncQueue(1);

const READ_ACTIONS = [
    'getAppSettings',
    'getTemplateHeaders',
    'getRecentOutingSheets',
    'getNamesList',
    'getPersonData',
    'fetchManualPairingData',
    'fetchCommAttendance',
    'getOutingDetails'
];

function getReadCacheKey(action, data) {
    return action + '_' + JSON.stringify(data || {});
}

// =========================================================
// IN-MEMORY AUTHORITATIVE STATE PATCHING
// Ensures 0ms read consistency & instant multiplayer updates
// =========================================================

function normalizeHeader(str) {
    if (!str) return "";
    return str.toString().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function patchCommAttendanceState(commData, multipleUpdates) {
    if (!commData || !commData.success) return false;
    if (!commData.attendance) commData.attendance = { '__GONE_HOME__': {} };
    if (!commData.busAttendance) commData.busAttendance = {};
    let changed = false;

    for (const [juncName, updates] of Object.entries(multipleUpdates || {})) {
        if (!Array.isArray(updates)) continue;
        const isBus = juncName.startsWith('__BUS__');
        const bName = isBus ? juncName.substring(7) : null;

        if (isBus) {
            if (!commData.busAttendance[bName]) commData.busAttendance[bName] = {};
        } else {
            if (!commData.attendance[juncName]) commData.attendance[juncName] = {};
            if (juncName !== '__GONE_HOME__' && Array.isArray(commData.junctures) && !commData.junctures.includes(juncName)) {
                commData.junctures.push(juncName);
            }
        }

        updates.forEach(u => {
            if (!u || !u.name) return;
            if (isBus) {
                if (commData.busAttendance[bName][u.name] !== u.status) {
                    commData.busAttendance[bName][u.name] = u.status;
                    changed = true;
                }
            } else {
                const boolStatus = u.status === true || String(u.status).toLowerCase() === 'true';
                if (commData.attendance[juncName][u.name] !== boolStatus) {
                    commData.attendance[juncName][u.name] = boolStatus;
                    changed = true;
                }
            }
        });
    }
    return changed;
}

function patchPairingDataFromCommSync(pairData, multipleUpdates) {
    if (!pairData || !pairData.success || !pairData.data || !Array.isArray(pairData.data.trainees)) return false;
    const goneHomeUpdates = multipleUpdates && multipleUpdates['__GONE_HOME__'];
    if (!Array.isArray(goneHomeUpdates)) return false;

    let changed = false;
    goneHomeUpdates.forEach(u => {
        if (!u || !u.name) return;
        const normName = String(u.name).toLowerCase().trim();
        const trainee = pairData.data.trainees.find(t => t.name && t.name.toLowerCase().trim() === normName);
        if (trainee) {
            const boolStatus = u.status === true || String(u.status).toLowerCase() === 'true';
            if (trainee.isGoneHome !== boolStatus) {
                trainee.isGoneHome = boolStatus;
                changed = true;
            }
        }
    });
    return changed;
}

function mergePairingOp(currentStr, op, volName) {
    const vols = currentStr ? String(currentStr).split(/[,|\n]+/).map(v => v.trim()).filter(v => v) : [];
    const target = String(volName || '').trim();
    if (!target) return vols.join(', ');
    const normTarget = target.toLowerCase();
    if (op === 'add') {
        if (!vols.some(v => v.toLowerCase() === normTarget)) {
            vols.push(target);
        }
        return vols.join(', ');
    }
    if (op === 'remove') {
        return vols.filter(v => v.toLowerCase() !== normTarget).join(', ');
    }
    return vols.join(', ');
}

function patchStatesOnPairingUpdate(sheetUrl, updates) {
    if (!sheetUrl || !Array.isArray(updates)) return;
    const pairKey = getReadCacheKey('fetchManualPairingData', { sheetUrl });
    const commKey = getReadCacheKey('fetchCommAttendance', { sheetUrl });

    const pairData = cache.get(pairKey);
    const commData = cache.get(commKey);

    updates.forEach(u => {
        if (!u || !u.traineeName) return;
        const normName = String(u.traineeName).toLowerCase().trim();
        const t = (pairData && pairData.success && pairData.data && Array.isArray(pairData.data.trainees))
            ? pairData.data.trainees.find(x => x.name && x.name.toLowerCase().trim() === normName)
            : null;
        const p = (commData && commData.success && Array.isArray(commData.participants))
            ? commData.participants.find(x => x.name && x.name.toLowerCase().trim() === normName)
            : null;

        let newVolPaired;
        if (u.op && u.volName) {
            const baseVolPaired = t ? t.volPaired : (p ? p.volPaired : (u.volPaired || ""));
            newVolPaired = mergePairingOp(baseVolPaired, u.op, u.volName);
            u.volPaired = newVolPaired;
        } else {
            newVolPaired = u.volPaired != null ? String(u.volPaired).trim() : "";
        }

        if (t) {
            t.volPaired = newVolPaired;
            if (t.extra) t.extra.t_paired_vol = newVolPaired;
        }
        if (p) {
            p.volPaired = newVolPaired;
            if (p.extra) p.extra.t_paired_vol = newVolPaired;
        }
    });
}

function patchStatesOnGroupingUpdate(sheetUrl, updates) {
    if (!sheetUrl || !Array.isArray(updates)) return;
    const pairKey = getReadCacheKey('fetchManualPairingData', { sheetUrl });
    const commKey = getReadCacheKey('fetchCommAttendance', { sheetUrl });

    const pairData = cache.get(pairKey);
    const commData = cache.get(commKey);

    updates.forEach(u => {
        if (!u) return;
        const rawName = u.name || u.traineeName;
        if (!rawName) return;
        const normName = String(rawName).toLowerCase().trim();

        if (u.role === 'TRAINEE' || u.traineeName) {
            const newGroup = u.group != null ? String(u.group).trim() : "";
            if (pairData && pairData.success && pairData.data && Array.isArray(pairData.data.trainees)) {
                const t = pairData.data.trainees.find(x => x.name && x.name.toLowerCase().trim() === normName);
                if (t) {
                    t.group = newGroup;
                    if (t.extra) t.extra.t_group = newGroup;
                }
            }
            if (commData && commData.success && Array.isArray(commData.participants)) {
                const p = commData.participants.find(x => x.name && x.name.toLowerCase().trim() === normName);
                if (p) {
                    p.group = newGroup;
                    if (p.extra) p.extra.t_group = newGroup;
                }
            }
        } else if (u.role === 'VOLUNTEER') {
            if (pairData && pairData.success && pairData.data && Array.isArray(pairData.data.volunteers)) {
                const v = pairData.data.volunteers.find(x => x.name && x.name.toLowerCase().trim() === normName);
                if (v) {
                    if (u.groupIC !== undefined) v.groupIC = Boolean(u.groupIC);
                    if (u.meetIC !== undefined) v.meetIC = Boolean(u.meetIC);
                    if (u.dismissIC !== undefined) v.dismissIC = Boolean(u.dismissIC);
                }
            }
        }
    });
}

function patchPersonAttendanceInMemory(type, targetName, data, pairData, commData, namesData) {
    if (!type || !data) return;
    const role = String(type).toUpperCase();
    const rawName = targetName || data['Name'] || data[Object.keys(data)[0]];
    if (!rawName) return;
    const name = String(rawName).trim();
    const normName = name.toLowerCase();

    let attVal = undefined;
    let meetLoc = undefined;
    let dismissLoc = undefined;
    let groupVal = undefined;
    let pairedVol = undefined;
    let caregiversVal = undefined;
    let remarkVal = undefined;
    let projectVal = undefined;

    for (const [k, v] of Object.entries(data)) {
        const normKey = normalizeHeader(k);
        if (normKey.includes("attending")) attVal = String(v).toLowerCase().trim();
        else if (normKey.includes("meetinglocation")) meetLoc = String(v).trim();
        else if (normKey.includes("dismissallocation")) dismissLoc = String(v).trim();
        else if (normKey.includes("group")) groupVal = String(v).trim();
        else if (normKey.includes("volpaired")) pairedVol = String(v).trim();
        else if (normKey.includes("caregiver")) caregiversVal = parseInt(v) || 0;
        else if (normKey.includes("remark")) remarkVal = String(v).trim();
        else if (normKey.includes("project")) projectVal = String(v).trim();
    }

    // 1. Patch fetchManualPairingData
    if (pairData && pairData.success && pairData.data) {
        if (role === 'TRAINEE') {
            let person = pairData.data.trainees.find(p => p.name.toLowerCase().trim() === normName);
            if (!person) {
                person = {
                    name,
                    role: 'TRAINEE',
                    caregivers: caregiversVal || 0,
                    attending: attVal !== undefined ? attVal : 'y',
                    volPaired: pairedVol || "",
                    project: projectVal || "",
                    group: groupVal || "",
                    isAttendingN: attVal === 'n',
                    isAttendingUnknown: attVal === '',
                    isGoneHome: false,
                    extra: { role: 'TRAINEE' }
                };
                pairData.data.trainees.push(person);
            }
            if (attVal !== undefined) {
                person.attending = attVal;
                person.isAttendingN = attVal === 'n';
                person.isAttendingUnknown = attVal === '';
                if (attVal === 'n') person.volPaired = "";
            }
            if (groupVal !== undefined) {
                person.group = groupVal;
                if (person.extra) person.extra.t_group = groupVal;
            }
            if (pairedVol !== undefined && attVal !== 'n') {
                person.volPaired = pairedVol;
                if (person.extra) person.extra.t_paired_vol = pairedVol;
            }
            if (caregiversVal !== undefined) person.caregivers = caregiversVal;
            if (meetLoc !== undefined && person.extra) person.extra.t_meet = meetLoc;
            if (dismissLoc !== undefined && person.extra) person.extra.t_dismiss = dismissLoc;
            if (remarkVal !== undefined && person.extra) person.extra.remark = remarkVal;
        } else if (role === 'VOLUNTEER') {
            let person = pairData.data.volunteers.find(p => p.name.toLowerCase().trim() === normName);
            if (attVal === 'n' || attVal === '') {
                pairData.data.volunteers = pairData.data.volunteers.filter(p => p.name.toLowerCase().trim() !== normName);
                if (attVal === 'n') {
                    pairData.data.trainees.forEach(t => {
                        if (t.volPaired && t.volPaired.toLowerCase().includes(normName)) {
                            const vols = t.volPaired.split(/[,|\n]+/).map(v => v.trim()).filter(v => v);
                            t.volPaired = vols.filter(v => v.toLowerCase() !== normName).join(', ');
                        }
                    });
                }
            } else {
                if (!person) {
                    person = {
                        name,
                        role: 'VOLUNTEER',
                        project: projectVal || "",
                        groupIC: false,
                        meetIC: false,
                        dismissIC: false,
                        extra: { role: 'VOLUNTEER' }
                    };
                    pairData.data.volunteers.push(person);
                }
                if (projectVal !== undefined && projectVal !== "") person.project = projectVal;
                if (meetLoc !== undefined && person.extra) person.extra.v_meet = meetLoc;
                if (dismissLoc !== undefined && person.extra) person.extra.v_dismiss = dismissLoc;
                if (groupVal !== undefined && person.extra) person.extra.v_group = groupVal;
                if (remarkVal !== undefined && person.extra) person.extra.remark = remarkVal;
            }
        }
    }

    // 2. Patch fetchCommAttendance
    if (commData && commData.success && Array.isArray(commData.participants)) {
        if (role === 'TRAINEE') {
            let person = commData.participants.find(p => p.name.toLowerCase().trim() === normName);
            if (attVal === 'n' || attVal === '') {
                commData.participants = commData.participants.filter(p => p.name.toLowerCase().trim() !== normName);
            } else {
                if (!person && (attVal === 'y' || attVal === undefined)) {
                    person = {
                        name,
                        group: groupVal || "",
                        caregivers: caregiversVal || 0,
                        volPaired: pairedVol || "",
                        meetingLoc: meetLoc || "",
                        dismissalLoc: dismissLoc || "",
                        extra: { role: 'TRAINEE' }
                    };
                    commData.participants.push(person);
                    if (commData.attendance && commData.attendance['__GONE_HOME__']) {
                        commData.attendance['__GONE_HOME__'][name] = false;
                    }
                }
                if (person) {
                    if (groupVal !== undefined) {
                        person.group = groupVal;
                        if (person.extra) person.extra.t_group = groupVal;
                    }
                    if (pairedVol !== undefined) {
                        person.volPaired = pairedVol;
                        if (person.extra) person.extra.t_paired_vol = pairedVol;
                    }
                    if (meetLoc !== undefined) {
                        person.meetingLoc = meetLoc;
                        if (person.extra) person.extra.t_meet = meetLoc;
                    }
                    if (dismissLoc !== undefined) {
                        person.dismissalLoc = dismissLoc;
                        if (person.extra) person.extra.t_dismiss = dismissLoc;
                    }
                    if (caregiversVal !== undefined) person.caregivers = caregiversVal;
                    if (remarkVal !== undefined && person.extra) person.extra.remark = remarkVal;
                }
            }
        } else if (role === 'VOLUNTEER' && attVal === 'n') {
            commData.participants.forEach(t => {
                if (t.volPaired && t.volPaired.toLowerCase().includes(normName)) {
                    const vols = t.volPaired.split(/[,|\n]+/).map(v => v.trim()).filter(v => v);
                    t.volPaired = vols.filter(v => v.toLowerCase() !== normName).join(', ');
                }
            });
        }
    }

    // 3. Patch getNamesList
    if (namesData && namesData.success && Array.isArray(namesData.names)) {
        if (!namesData.names.some(n => n.toLowerCase().trim() === normName)) {
            namesData.names.push(name);
            namesData.names.sort();
        }
    }
}

function patchStatesOnPersonAttendanceUpdate(sheetUrl, type, targetName, data) {
    if (!sheetUrl || !type || !data) return;
    const rawName = targetName || data['Name'] || data[Object.keys(data)[0]];
    const name = rawName ? String(rawName).trim() : '';

    const pairData = cache.get(getReadCacheKey('fetchManualPairingData', { sheetUrl }));
    const commData = cache.get(getReadCacheKey('fetchCommAttendance', { sheetUrl }));
    const namesData = cache.get(getReadCacheKey('getNamesList', { url: sheetUrl, type: type.toLowerCase() }));

    patchPersonAttendanceInMemory(type, targetName, data, pairData, commData, namesData);

    // Clear person/details caches
    if (name) {
        const personKey = getReadCacheKey('getPersonData', { url: sheetUrl, type: type.toLowerCase(), name });
        cache.del(personKey);
    }
    cache.del(getReadCacheKey('getOutingDetails', sheetUrl));
}

function applyPendingMutationsToState(action, reqData, responseData) {
    if (!responseData || !responseData.success) return responseData;
    const sheetUrl = (reqData && typeof reqData === 'object') ? (reqData.sheetUrl || reqData.url) : (typeof reqData === 'string' ? reqData : null);
    if (!sheetUrl || !pendingServerMutations.has(sheetUrl)) return responseData;

    const mutations = pendingServerMutations.get(sheetUrl);
    for (const m of mutations) {
        if (action === 'fetchCommAttendance') {
            if (m.type === 'syncCommAttendance') {
                patchCommAttendanceState(responseData, m.payload.multipleUpdates);
            } else if (m.type === 'syncManualPairingUpdates') {
                (m.payload.updates || []).forEach(u => {
                    const normName = String(u.traineeName || '').toLowerCase().trim();
                    const p = (responseData.participants || []).find(x => x.name.toLowerCase().trim() === normName);
                    if (p) {
                        p.volPaired = (u.op && u.volName)
                            ? mergePairingOp(p.volPaired, u.op, u.volName)
                            : (u.volPaired != null ? String(u.volPaired).trim() : "");
                        if (p.extra) p.extra.t_paired_vol = p.volPaired;
                    }
                });
            } else if (m.type === 'syncManualGroupingUpdates') {
                (m.payload.updates || []).forEach(u => {
                    if (u.role === 'TRAINEE' || u.traineeName) {
                        const normName = String(u.name || u.traineeName || '').toLowerCase().trim();
                        const p = (responseData.participants || []).find(x => x.name.toLowerCase().trim() === normName);
                        if (p) p.group = u.group;
                    }
                });
            } else if (m.type === 'submitAttendanceData' && m.payload) {
                patchPersonAttendanceInMemory(m.payload.type, m.payload.targetName, m.payload.data, null, responseData, null);
            }
        } else if (action === 'fetchManualPairingData' && responseData.data) {
            if (m.type === 'syncCommAttendance') {
                patchPairingDataFromCommSync(responseData, m.payload.multipleUpdates);
            } else if (m.type === 'syncManualPairingUpdates') {
                (m.payload.updates || []).forEach(u => {
                    const normName = String(u.traineeName || '').toLowerCase().trim();
                    const t = (responseData.data.trainees || []).find(x => x.name.toLowerCase().trim() === normName);
                    if (t) {
                        t.volPaired = (u.op && u.volName)
                            ? mergePairingOp(t.volPaired, u.op, u.volName)
                            : (u.volPaired != null ? String(u.volPaired).trim() : "");
                        if (t.extra) t.extra.t_paired_vol = t.volPaired;
                    }
                });
            } else if (m.type === 'syncManualGroupingUpdates') {
                (m.payload.updates || []).forEach(u => {
                    const normName = String(u.name || u.traineeName || '').toLowerCase().trim();
                    if (u.role === 'TRAINEE' || u.traineeName) {
                        const t = (responseData.data.trainees || []).find(x => x.name.toLowerCase().trim() === normName);
                        if (t) t.group = u.group;
                    } else if (u.role === 'VOLUNTEER') {
                        const v = (responseData.data.volunteers || []).find(x => x.name.toLowerCase().trim() === normName);
                        if (v) {
                            if (u.groupIC !== undefined) v.groupIC = Boolean(u.groupIC);
                            if (u.meetIC !== undefined) v.meetIC = Boolean(u.meetIC);
                            if (u.dismissIC !== undefined) v.dismissIC = Boolean(u.dismissIC);
                        }
                    }
                });
            } else if (m.type === 'submitAttendanceData' && m.payload) {
                patchPersonAttendanceInMemory(m.payload.type, m.payload.targetName, m.payload.data, responseData, null, null);
            }
        } else if (action === 'getNamesList') {
            if (m.type === 'submitAttendanceData' && m.payload && reqData && String(m.payload.type || '').toLowerCase() === String(reqData.type || '').toLowerCase()) {
                patchPersonAttendanceInMemory(m.payload.type, m.payload.targetName, m.payload.data, null, null, responseData);
            }
        }
    }
    return responseData;
}

// =========================================================
// WEBSOCKET REAL-TIME MULTIPLAYER HUB
// =========================================================

// Map<WebSocket, { clientId, sheetUrl, view, label, color, activeItem, joinedAt }>
const clients = new Map();

// Store custom bus options per sheetUrl + juncture in memory so all collaborators see added/removed buses
// Map<sheetUrl, Record<juncture, string[]>>
const roomBusOptions = new Map();

function attachRoomBusOptions(sheetUrl, commData) {
    if (sheetUrl && commData && commData.success && roomBusOptions.has(sheetUrl)) {
        commData.busOptions = roomBusOptions.get(sheetUrl);
    }
    return commData;
}

const COLLAB_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#06b6d4'
];

function broadcastToAll(messageObj, excludeWs = null) {
    const raw = JSON.stringify(messageObj);
    for (const [ws] of clients.entries()) {
        if (ws !== excludeWs && ws.readyState === 1) {
            try { ws.send(raw); } catch (e) {}
        }
    }
}

function broadcastToSheet(sheetUrl, messageObj, excludeWs = null) {
    if (!sheetUrl) {
        return broadcastToAll(messageObj, excludeWs);
    }
    const raw = JSON.stringify(messageObj);
    for (const [ws, meta] of clients.entries()) {
        if (ws !== excludeWs && ws.readyState === 1) {
            // Send to clients on the same sheetUrl OR on global dashboards (admin/index)
            if (!meta.sheetUrl || meta.sheetUrl === sheetUrl || meta.view === 'admin' || meta.view === 'index') {
                try { ws.send(raw); } catch (e) {}
            }
        }
    }
}

function broadcastPresence(sheetUrl = null) {
    const allUsers = [];
    for (const [ws, meta] of clients.entries()) {
        if (ws.readyState === 1) {
            allUsers.push({
                clientId: meta.clientId,
                sheetUrl: meta.sheetUrl,
                view: meta.view,
                label: meta.label,
                color: meta.color,
                activeItem: meta.activeItem || null
            });
        }
    }

    for (const [ws, meta] of clients.entries()) {
        if (ws.readyState !== 1) continue;
        if (sheetUrl && meta.sheetUrl && meta.sheetUrl !== sheetUrl && meta.view !== 'admin') continue;

        const sameSheetUsers = meta.sheetUrl
            ? allUsers.filter(u => u.sheetUrl === meta.sheetUrl)
            : allUsers;

        try {
            ws.send(JSON.stringify({
                type: 'presence:state',
                totalOnline: allUsers.length,
                sheetOnline: sameSheetUsers.length,
                users: sameSheetUsers
            }));
        } catch (e) {}
    }
}

wss.on('connection', (ws) => {
    const color = COLLAB_COLORS[clients.size % COLLAB_COLORS.length];
    const defaultMeta = {
        clientId: 'u_' + Math.random().toString(36).substring(2, 9),
        sheetUrl: null,
        view: 'landing',
        label: 'Collaborator',
        color,
        activeItem: null,
        joinedAt: Date.now()
    };
    clients.set(ws, defaultMeta);

    ws.on('message', (rawMsg) => {
        let msg;
        try {
            msg = JSON.parse(rawMsg.toString());
        } catch (e) {
            return;
        }

        const meta = clients.get(ws);
        if (!meta) return;

        switch (msg.type) {
            case 'presence:join':
            case 'presence:update': {
                const prevSheet = meta.sheetUrl;
                if (msg.clientId) meta.clientId = msg.clientId;
                if (msg.sheetUrl !== undefined) meta.sheetUrl = msg.sheetUrl;
                if (msg.view) meta.view = msg.view;
                if (msg.label) meta.label = msg.label;
                if (msg.activeItem !== undefined) meta.activeItem = msg.activeItem;

                broadcastPresence(meta.sheetUrl || prevSheet);

                // If client joined a sheet that has custom bus options, send them immediately
                if (meta.sheetUrl && roomBusOptions.has(meta.sheetUrl)) {
                    try {
                        ws.send(JSON.stringify({
                            type: 'delta:busOptionsAll',
                            sheetUrl: meta.sheetUrl,
                            busOptions: roomBusOptions.get(meta.sheetUrl),
                            busOptionsByJuncture: roomBusOptions.get(meta.sheetUrl)
                        }));
                    } catch (e) {}
                }
                break;
            }

            // Ephemeral real-time interaction states (dragging a card, quick-editing a person)
            case 'ephemeral:focus': {
                meta.activeItem = msg.item || null;
                broadcastToSheet(meta.sheetUrl || msg.sheetUrl, {
                    type: 'ephemeral:focus',
                    clientId: meta.clientId,
                    color: meta.color,
                    label: meta.label,
                    view: meta.view,
                    sheetUrl: meta.sheetUrl || msg.sheetUrl,
                    item: msg.item || null
                }, ws);
                break;
            }

            // Instant 0ms optimistic mutations from clients before/during HTTP sync
            case 'live:commAttendance': {
                const { sheetUrl, multipleUpdates } = msg;
                if (!sheetUrl || !multipleUpdates) break;
                touchLiveWsMutation(sheetUrl);
                const commKey = getReadCacheKey('fetchCommAttendance', { sheetUrl });
                const pairKey = getReadCacheKey('fetchManualPairingData', { sheetUrl });
                const commData = cache.get(commKey);
                if (commData) patchCommAttendanceState(commData, multipleUpdates);
                const pairData = cache.get(pairKey);
                if (pairData) patchPairingDataFromCommSync(pairData, multipleUpdates);

                broadcastToSheet(sheetUrl, {
                    type: 'delta:commAttendance',
                    sheetUrl,
                    multipleUpdates,
                    senderId: msg.senderId || meta.clientId,
                    timestamp: Date.now()
                }, ws);
                break;
            }

            case 'live:busOptions': {
                const { sheetUrl, juncture, busOptions, action: busAction, busName } = msg;
                if (!sheetUrl || !juncture || (!Array.isArray(busOptions) && !busName)) break;
                touchLiveWsMutation(sheetUrl);

                if (!roomBusOptions.has(sheetUrl)) roomBusOptions.set(sheetUrl, {});
                const currentMap = roomBusOptions.get(sheetUrl);
                let opts = Array.isArray(currentMap[juncture]) ? [...currentMap[juncture]] : null;
                if (!opts) {
                    const set = new Set(['Bus 1']);
                    const commData = cache.get(getReadCacheKey('fetchCommAttendance', { sheetUrl }));
                    if (commData && commData.busAttendance && commData.busAttendance[juncture]) {
                        Object.values(commData.busAttendance[juncture]).forEach(b => {
                            if (b && String(b).trim()) set.add(String(b).trim());
                        });
                    }
                    opts = Array.from(set);
                }

                const cleanBusName = busName ? String(busName).trim() : '';
                if (busAction === 'add' && cleanBusName) {
                    if (!opts.includes(cleanBusName)) opts.push(cleanBusName);
                } else if (busAction === 'remove' && cleanBusName) {
                    opts = opts.filter(b => b !== cleanBusName);
                    if (opts.length === 0) opts = ['Bus 1'];
                } else if (Array.isArray(busOptions)) {
                    opts = Array.from(new Set([...opts, ...busOptions.map(b => String(b).trim()).filter(Boolean)]));
                }

                opts.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                currentMap[juncture] = opts;

                const commData = cache.get(getReadCacheKey('fetchCommAttendance', { sheetUrl }));
                if (commData && commData.success) attachRoomBusOptions(sheetUrl, commData);

                const sentSorted = Array.isArray(busOptions)
                    ? [...busOptions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                    : [];
                const mergedDiffersFromSender = JSON.stringify(opts) !== JSON.stringify(sentSorted);

                broadcastToSheet(sheetUrl, {
                    type: 'delta:busOptions',
                    sheetUrl,
                    juncture,
                    busOptions: opts,
                    senderId: msg.senderId || meta.clientId,
                    forceApply: mergedDiffersFromSender,
                    timestamp: Date.now()
                }, mergedDiffersFromSender ? null : ws);
                break;
            }

            case 'live:pairing': {
                const { sheetUrl, updates } = msg;
                if (!sheetUrl || !Array.isArray(updates)) break;
                touchLiveWsMutation(sheetUrl);
                patchStatesOnPairingUpdate(sheetUrl, updates);

                broadcastToSheet(sheetUrl, {
                    type: 'delta:pairing',
                    sheetUrl,
                    updates,
                    senderId: msg.senderId || meta.clientId,
                    timestamp: Date.now()
                }, ws);
                break;
            }

            case 'live:grouping': {
                const { sheetUrl, updates, activeGroups, deletedGroup } = msg;
                if (!sheetUrl) break;
                touchLiveWsMutation(sheetUrl);
                if (Array.isArray(updates)) {
                    patchStatesOnGroupingUpdate(sheetUrl, updates);
                }

                broadcastToSheet(sheetUrl, {
                    type: 'delta:grouping',
                    sheetUrl,
                    updates: updates || [],
                    activeGroups: activeGroups || null,
                    deletedGroup: deletedGroup || null,
                    senderId: msg.senderId || meta.clientId,
                    timestamp: Date.now()
                }, ws);
                break;
            }

            case 'live:personAttendance': {
                const { sheetUrl, targetName, data } = msg;
                const role = msg.role || msg.personType;
                if (!sheetUrl || !role || !data) break;
                touchLiveWsMutation(sheetUrl);
                patchStatesOnPersonAttendanceUpdate(sheetUrl, role, targetName, data);

                broadcastToSheet(sheetUrl, {
                    type: 'delta:personAttendance',
                    sheetUrl,
                    role,
                    personType: role,
                    targetName,
                    data,
                    senderId: msg.senderId || meta.clientId,
                    timestamp: Date.now()
                }, ws);
                break;
            }

            case 'ping': {
                try { ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() })); } catch (e) {}
                break;
            }
        }
    });

    ws.on('close', () => {
        const meta = clients.get(ws);
        const prevSheet = meta ? meta.sheetUrl : null;
        if (meta && meta.activeItem) {
            broadcastToSheet(prevSheet, {
                type: 'ephemeral:focus',
                clientId: meta.clientId,
                sheetUrl: prevSheet,
                item: null
            }, ws);
        }
        clients.delete(ws);
        broadcastPresence(prevSheet);
    });
});

// =========================================================
// GAS FETCH HELPER
// =========================================================

async function fetchFromGAS(action, data, maxAttempts = 3) {
    const payload = JSON.stringify({ action, data });
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const gasResponse = await _fetch(config.GAS_BACKEND_URL, {
                method: 'POST',
                body: payload,
                headers: {
                    'Content-Type': 'text/plain;charset=utf-8',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                },
                redirect: 'follow'
            });

            const text = await gasResponse.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                const errorMsg = "Invalid JSON from GAS: " + text.substring(0, 100);
                console.warn(`[WARN] ${action} attempt ${attempt} failed: ${errorMsg}`);
                lastError = new Error(errorMsg);
                if (attempt < maxAttempts) await new Promise(res => setTimeout(res, attempt * 1000));
            }
        } catch (err) {
            console.warn(`[WARN] ${action} attempt ${attempt} network error: ${err.message}`);
            lastError = err;
            if (attempt < maxAttempts) await new Promise(res => setTimeout(res, attempt * 1000));
        }
    }
    throw lastError;
}

function getOutingThresholdDateNum() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const tY = d.getFullYear();
    const tM = String(d.getMonth() + 1).padStart(2, '0');
    const tD = String(d.getDate()).padStart(2, '0');
    return parseInt(`${tY}${tM}${tD}`, 10);
}

function filterRecentOutingSheets(resObj) {
    if (!resObj || !resObj.success || !Array.isArray(resObj.data)) return resObj;
    const threshold = getOutingThresholdDateNum();
    resObj.data = resObj.data.filter(item => {
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
    return resObj;
}

async function executeReadAction(action, data, bypassCache = false) {
    const cacheKey = getReadCacheKey(action, data);
    const sheetUrl = (data && typeof data === 'object') ? (data.sheetUrl || data.url) : (typeof data === 'string' ? data : null);

    if (!bypassCache) {
        const cachedResponse = cache.get(cacheKey);
        if (cachedResponse) {
            const patched = applyPendingMutationsToState(action, data, cachedResponse);
            return action === 'getRecentOutingSheets'
                ? filterRecentOutingSheets(patched)
                : (action === 'fetchCommAttendance' ? attachRoomBusOptions(sheetUrl, patched) : patched);
        }
    }

    if (inFlightRequests.has(cacheKey)) {
        const res = await inFlightRequests.get(cacheKey);
        const patched = applyPendingMutationsToState(action, data, res);
        return action === 'getRecentOutingSheets'
            ? filterRecentOutingSheets(patched)
            : (action === 'fetchCommAttendance' ? attachRoomBusOptions(sheetUrl, patched) : patched);
    }

    const fetchPromise = (async () => {
        const readStartedAt = Date.now();
        const parsed = await fetchFromGAS(action, data, 3);
        const existingCached = cache.get(cacheKey);
        if (bypassCache && sheetUrl && (lastLiveWsMutationAt.get(sheetUrl) || 0) > readStartedAt && existingCached) {
            const kept = applyPendingMutationsToState(action, data, existingCached);
            return action === 'fetchCommAttendance' ? attachRoomBusOptions(sheetUrl, kept) : kept;
        }
        let patched = applyPendingMutationsToState(action, data, parsed);
        if (action === 'getRecentOutingSheets') {
            patched = filterRecentOutingSheets(patched);
        } else if (action === 'fetchCommAttendance') {
            patched = attachRoomBusOptions(sheetUrl, patched);
        }
        if (patched && patched.success !== false) {
            cache.set(cacheKey, patched);
        }
        return patched;
    })();

    inFlightRequests.set(cacheKey, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        inFlightRequests.delete(cacheKey);
    }
}

// =========================================================
// BACKGROUND LIVE SHEET WATCHER FOR ACTIVE COLLABORATORS
// Detects external Google Sheet edits and pushes live diffs
// =========================================================

setInterval(async () => {
    if (writeQueue.isBusy) return;

    const activeSheets = new Map(); // sheetUrl -> Set<views>
    for (const [ws, meta] of clients.entries()) {
        if (ws.readyState === 1 && meta.sheetUrl) {
            if (!activeSheets.has(meta.sheetUrl)) activeSheets.set(meta.sheetUrl, new Set());
            activeSheets.get(meta.sheetUrl).add(meta.view);
        }
    }

    for (const [sheetUrl, views] of activeSheets.entries()) {
        const lastWsAt = lastLiveWsMutationAt.get(sheetUrl) || 0;
        if (writeQueue.isBusy || pendingServerMutations.has(sheetUrl) || (Date.now() - lastWsAt < 3000)) continue;

        try {
            if (views.has('tracker')) {
                const commKey = getReadCacheKey('fetchCommAttendance', { sheetUrl });
                const oldComm = cache.get(commKey);
                const oldStr = oldComm ? JSON.stringify(oldComm) : null;
                const pollStartedAt = Date.now();
                const freshComm = await executeReadAction('fetchCommAttendance', { sheetUrl }, true);
                if (freshComm && freshComm.success && !pendingServerMutations.has(sheetUrl) && (lastLiveWsMutationAt.get(sheetUrl) || 0) <= pollStartedAt) {
                    const newStr = JSON.stringify(freshComm);
                    if (oldStr !== newStr) {
                        broadcastToSheet(sheetUrl, {
                            type: 'state:commAttendance',
                            sheetUrl,
                            data: freshComm,
                            timestamp: Date.now()
                        });
                    }
                }
            }

            if (views.has('pairing') || views.has('grouping')) {
                const pairKey = getReadCacheKey('fetchManualPairingData', { sheetUrl });
                const oldPair = cache.get(pairKey);
                const oldStr = oldPair ? JSON.stringify(oldPair) : null;
                const pollStartedAt = Date.now();
                const freshPair = await executeReadAction('fetchManualPairingData', { sheetUrl }, true);
                if (freshPair && freshPair.success && !pendingServerMutations.has(sheetUrl) && (lastLiveWsMutationAt.get(sheetUrl) || 0) <= pollStartedAt) {
                    const newStr = JSON.stringify(freshPair);
                    if (oldStr !== newStr) {
                        broadcastToSheet(sheetUrl, {
                            type: 'state:pairingData',
                            sheetUrl,
                            data: freshPair.data,
                            timestamp: Date.now()
                        });
                    }
                }
            }
        } catch (e) {}
    }
}, 8000);

// =========================================================
// EXPRESS API ROUTES
// =========================================================

app.use(express.text({ type: '*/*', limit: '50mb' }));

app.post('/api', async (req, res) => {
    let parsedBody;
    try {
        parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid JSON body' });
    }

    const { action, data, clientId } = parsedBody;
    if (!action) {
        return res.status(400).json({ success: false, message: 'Missing action' });
    }

    if (action === 'forceBackendRefresh') {
        console.log(`[CACHE CLEARED] via forceBackendRefresh`);
        cache.flushAll();
    }

    const isRead = READ_ACTIONS.includes(action);

    if (isRead) {
        try {
            const response = await executeReadAction(action, data, false);
            return res.json(response);
        } catch (err) {
            console.error(`[ERROR] ${action}:`, err.message);
            return res.status(500).json({ success: false, message: 'Server Error contacting backend' });
        }
    } else {
        // =========================================================
        // WRITE ACTIONS:
        // 1. Apply in-memory patch immediately
        // 2. Broadcast delta to all WebSocket clients immediately
        // 3. Queue write to GAS and reconcile state when complete
        // =========================================================
        console.log(`[QUEUE] Processing write action: ${action}`);

        const sheetUrl = (data && typeof data === 'object') ? (data.sheetUrl || data.url) : (typeof data === 'string' ? data : null);
        let mutationId = null;

        if (action === 'syncCommAttendance' && data && data.sheetUrl && data.multipleUpdates) {
            mutationId = addPendingServerMutation(data.sheetUrl, action, data);
            const commKey = getReadCacheKey('fetchCommAttendance', { sheetUrl: data.sheetUrl });
            const pairKey = getReadCacheKey('fetchManualPairingData', { sheetUrl: data.sheetUrl });
            const commData = cache.get(commKey);
            if (commData) patchCommAttendanceState(commData, data.multipleUpdates);
            const pairData = cache.get(pairKey);
            if (pairData) patchPairingDataFromCommSync(pairData, data.multipleUpdates);

            broadcastToSheet(data.sheetUrl, {
                type: 'delta:commAttendance',
                sheetUrl: data.sheetUrl,
                multipleUpdates: data.multipleUpdates,
                senderId: clientId || null,
                timestamp: Date.now()
            });
        } else if (action === 'syncManualPairingUpdates' && data && data.sheetUrl && data.updates) {
            mutationId = addPendingServerMutation(data.sheetUrl, action, data);
            patchStatesOnPairingUpdate(data.sheetUrl, data.updates);

            broadcastToSheet(data.sheetUrl, {
                type: 'delta:pairing',
                sheetUrl: data.sheetUrl,
                updates: data.updates,
                senderId: clientId || null,
                timestamp: Date.now()
            });
        } else if (action === 'syncManualGroupingUpdates' && data && data.sheetUrl && data.updates) {
            mutationId = addPendingServerMutation(data.sheetUrl, action, data);
            patchStatesOnGroupingUpdate(data.sheetUrl, data.updates);

            broadcastToSheet(data.sheetUrl, {
                type: 'delta:grouping',
                sheetUrl: data.sheetUrl,
                updates: data.updates,
                senderId: clientId || null,
                timestamp: Date.now()
            });
        } else if (action === 'submitAttendanceData' && data && data.sheetUrl) {
            mutationId = addPendingServerMutation(data.sheetUrl, action, data);
            patchStatesOnPersonAttendanceUpdate(data.sheetUrl, data.type, data.targetName, data.data);

            broadcastToSheet(data.sheetUrl, {
                type: 'delta:personAttendance',
                sheetUrl: data.sheetUrl,
                role: data.type,
                personType: data.type,
                targetName: data.targetName,
                data: data.data,
                senderId: clientId || null,
                timestamp: Date.now()
            });
        }

        try {
            const response = await writeQueue.add(async () => {
                try {
                    if (action === 'syncManualPairingUpdates' && data && data.sheetUrl && Array.isArray(data.updates) && data.updates.some(u => u && u.op && u.volName)) {
                        const pairKey = getReadCacheKey('fetchManualPairingData', { sheetUrl: data.sheetUrl });
                        if (!cache.get(pairKey)) {
                            await executeReadAction('fetchManualPairingData', { sheetUrl: data.sheetUrl }, false);
                        }
                        patchStatesOnPairingUpdate(data.sheetUrl, data.updates);
                    }

                    const parsed = await fetchFromGAS(action, data, 3);

                    // Post-write cache management & reconciliation broadcasts
                    if (action === 'addCommJuncture' || action === 'deleteCommJuncture') {
                        if (parsed && parsed.success && sheetUrl) {
                            applyPendingMutationsToState('fetchCommAttendance', { sheetUrl }, parsed);
                            attachRoomBusOptions(sheetUrl, parsed);
                            const commKey = getReadCacheKey('fetchCommAttendance', { sheetUrl });
                            cache.set(commKey, parsed);
                            broadcastToSheet(sheetUrl, {
                                type: 'state:commAttendance',
                                sheetUrl,
                                data: parsed,
                                senderId: clientId || null,
                                timestamp: Date.now()
                            });
                        }
                    } else if (action === 'runAutoPairing' || action === 'runAutoGrouping') {
                        if (parsed && parsed.success && sheetUrl) {
                            cache.del(getReadCacheKey('fetchManualPairingData', { sheetUrl }));
                            cache.del(getReadCacheKey('fetchCommAttendance', { sheetUrl }));
                            cache.del(getReadCacheKey('getOutingDetails', sheetUrl));
                            // Pre-warm and broadcast updated pairing & comm state
                            Promise.all([
                                executeReadAction('fetchManualPairingData', { sheetUrl }, true),
                                executeReadAction('fetchCommAttendance', { sheetUrl }, true)
                            ]).then(([freshPair, freshComm]) => {
                                if (freshPair && freshPair.success) {
                                    broadcastToSheet(sheetUrl, {
                                        type: 'state:pairingData',
                                        sheetUrl,
                                        data: freshPair.data,
                                        timestamp: Date.now()
                                    });
                                }
                                if (freshComm && freshComm.success) {
                                    broadcastToSheet(sheetUrl, {
                                        type: 'state:commAttendance',
                                        sheetUrl,
                                        data: freshComm,
                                        timestamp: Date.now()
                                    });
                                }
                            }).catch(() => {});
                        }
                    } else if (action === 'submitAttendanceData') {
                        if (parsed && parsed.success && sheetUrl) {
                            // Refresh live stats and pairing/comm caches in background so Comm Dashboard & Trackers have full server-computed fields
                            cache.del(getReadCacheKey('getOutingDetails', sheetUrl));
                            executeReadAction('getOutingDetails', sheetUrl, true).then(freshStats => {
                                if (freshStats && freshStats.success) {
                                    broadcastToSheet(sheetUrl, {
                                        type: 'state:outingStats',
                                        sheetUrl,
                                        statsData: freshStats,
                                        timestamp: Date.now()
                                    });
                                }
                            }).catch(() => {});
                        }
                    } else if (action === 'createOuting' || action === 'updateOuting' || action === 'forceBackendRefresh') {
                        cache.flushAll();
                        executeReadAction('getRecentOutingSheets', null, true).then(freshOutings => {
                            if (freshOutings && freshOutings.success) {
                                broadcastToAll({
                                    type: 'global:outingsUpdated',
                                    sheets: freshOutings.data,
                                    sheetUrl: sheetUrl || null,
                                    timestamp: Date.now()
                                });
                            }
                        }).catch(() => {});
                    } else if (action === 'saveAppSettings') {
                        cache.del(getReadCacheKey('getAppSettings', null));
                        cache.set(getReadCacheKey('getAppSettings', null), data);
                        broadcastToAll({
                            type: 'global:settingsUpdated',
                            settings: data,
                            timestamp: Date.now()
                        });
                    }

                    return parsed;
                } finally {
                    if (mutationId && sheetUrl) {
                        removePendingServerMutation(sheetUrl, mutationId);
                    }
                }
            });

            return res.json(response);
        } catch (err) {
            console.error(`[ERROR] Write action ${action} failed:`, err.message);
            return res.status(500).json({ success: false, message: 'Server Error on Write' });
        }
    }
});

// Serve static files from the root directory
app.use(express.static(__dirname));

server.listen(port, '0.0.0.0', () => {
    console.log(`Server & Real-Time Collaboration Hub listening on port ${port}`);
    console.log(`Proxying API requests to GAS: ${config.GAS_BACKEND_URL}`);
});
