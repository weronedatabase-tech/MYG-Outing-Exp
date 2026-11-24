/***
 * API Caller Wrapper & Real-Time Collaborative WebSocket Engine
 * Uses API_URL globally defined in backend/config.js
 */

(function initCollabIdentity() {
    window.collabClientId = 'c_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
})();

window.collabState = {
    connected: false,
    ws: null,
    reconnectDelay: 1000,
    reconnectTimer: null,
    pingInterval: null,
    view: 'landing',
    sheetUrl: null,
    label: 'User',
    activeItem: null,
    onlineCount: 1,
    sheetUsers: [],
    remoteFocusMap: new Map(), // key: name_lower -> { clientId, color, label, action, expiresAt }
    listeners: {},
    pendingWsQueue: [],
    hasConnectedOnce: false
};

window.collabOn = function(type, handler) {
    if (!window.collabState.listeners[type]) {
        window.collabState.listeners[type] = [];
    }
    window.collabState.listeners[type].push(handler);
};

function emitCollabLocal(type, payload) {
    const handlers = window.collabState.listeners[type];
    if (handlers && handlers.length > 0) {
        handlers.forEach(fn => {
            try { fn(payload); } catch (e) { console.error(`[Collab Handler Error: ${type}]`, e); }
        });
    }
}

window.collabSend = function(payload) {
    const message = Object.assign({}, payload, {
        senderId: window.collabClientId
    });
    const raw = JSON.stringify(message);
    if (window.collabState.ws && window.collabState.ws.readyState === WebSocket.OPEN) {
        try {
            window.collabState.ws.send(raw);
        } catch (e) {}
    } else {
        // Buffer only live mutation messages (skip ephemeral focus if offline)
        if (payload && payload.type && payload.type.startsWith('live:')) {
            window.collabState.pendingWsQueue.push(raw);
            if (window.collabState.pendingWsQueue.length > 50) {
                window.collabState.pendingWsQueue.shift();
            }
        }
    }
};

window.collabSetContext = function(view, sheetUrl, label) {
    if (view) window.collabState.view = view;
    if (sheetUrl !== undefined) window.collabState.sheetUrl = sheetUrl;
    if (label) window.collabState.label = label;

    window.collabSend({
        type: 'presence:update',
        clientId: window.collabClientId,
        view: window.collabState.view,
        sheetUrl: window.collabState.sheetUrl,
        label: window.collabState.label,
        activeItem: window.collabState.activeItem
    });
};

window.collabEmitFocus = function(item) {
    window.collabState.activeItem = item || null;
    if (window.collabState.ws && window.collabState.ws.readyState === WebSocket.OPEN) {
        try {
            window.collabState.ws.send(JSON.stringify({
                type: 'ephemeral:focus',
                clientId: window.collabClientId,
                sheetUrl: window.collabState.sheetUrl,
                item: item || null
            }));
        } catch (e) {}
    }
};

function detectInitialContext() {
    const path = (window.location.pathname || '').toLowerCase();
    const params = new URLSearchParams(window.location.search);
    const urlParam = params.get('url') || null;

    let view = 'index';
    let label = 'Home';
    if (path.includes('tracker')) { view = 'tracker'; label = 'Live Tracker'; }
    else if (path.includes('pairing')) { view = 'pairing'; label = 'Manual Pairing'; }
    else if (path.includes('grouping')) { view = 'grouping'; label = 'Manual Grouping'; }
    else if (path.includes('admin')) { view = 'admin'; label = 'Comm Dashboard'; }
    else if (path.includes('volunteer')) { view = 'volunteer'; label = 'Attendance Form'; }
    else if (path.includes('settings')) { view = 'settings'; label = 'Settings'; }

    window.collabState.view = view;
    if (urlParam) window.collabState.sheetUrl = urlParam;
    window.collabState.label = label;
}

function connectCollabWebSocket() {
    if (window.collabState.ws && (window.collabState.ws.readyState === WebSocket.OPEN || window.collabState.ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    detectInitialContext();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    let ws;
    try {
        ws = new WebSocket(wsUrl);
    } catch (e) {
        scheduleReconnect();
        return;
    }

    window.collabState.ws = ws;

    ws.onopen = () => {
        const wasReconnect = window.collabState.hasConnectedOnce;
        window.collabState.connected = true;
        window.collabState.hasConnectedOnce = true;
        window.collabState.reconnectDelay = 1000;

        // Announce presence & room context
        ws.send(JSON.stringify({
            type: 'presence:join',
            clientId: window.collabClientId,
            view: window.collabState.view,
            sheetUrl: window.collabState.sheetUrl,
            label: window.collabState.label,
            activeItem: window.collabState.activeItem
        }));

        // Flush any buffered live mutations
        while (window.collabState.pendingWsQueue.length > 0) {
            const raw = window.collabState.pendingWsQueue.shift();
            try { ws.send(raw); } catch (e) {}
        }

        emitCollabLocal('connection:state', { connected: true, reconnected: wasReconnect });

        if (wasReconnect) {
            emitCollabLocal('connection:reconnected', { sheetUrl: window.collabState.sheetUrl });
            emitCollabLocal('collab:reconnected', { sheetUrl: window.collabState.sheetUrl });
        }

        if (window.collabState.pingInterval) clearInterval(window.collabState.pingInterval);
        window.collabState.pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
            }
        }, 25000);
    };

    ws.onmessage = (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            return;
        }
        if (!msg || !msg.type) return;

        // Ignore our own echoed deltas unless server explicitly marks forceApply (e.g., resolved merge)
        if (msg.senderId && msg.senderId === window.collabClientId && !msg.forceApply) {
            return;
        }

        if (msg.type === 'presence:state') {
            window.collabState.onlineCount = msg.sheetOnline || msg.totalOnline || 1;
            window.collabState.sheetUsers = msg.users || [];
        }

        emitCollabLocal(msg.type, msg);
    };

    ws.onclose = () => {
        window.collabState.connected = false;
        if (window.collabState.pingInterval) {
            clearInterval(window.collabState.pingInterval);
            window.collabState.pingInterval = null;
        }
        emitCollabLocal('connection:state', { connected: false, reconnected: false });
        scheduleReconnect();
    };

    ws.onerror = () => {
        try { ws.close(); } catch (e) {}
    };
}

function scheduleReconnect() {
    if (window.collabState.reconnectTimer) clearTimeout(window.collabState.reconnectTimer);
    const delay = window.collabState.reconnectDelay;
    window.collabState.reconnectDelay = Math.min(delay * 1.5, 8000);
    window.collabState.reconnectTimer = setTimeout(() => {
        connectCollabWebSocket();
    }, delay);
}

// Re-verify connection & sync when tab regains visibility or network returns
window.addEventListener('online', () => {
    connectCollabWebSocket();
    emitCollabLocal('connection:reconnected', { sheetUrl: window.collabState.sheetUrl });
    emitCollabLocal('collab:reconnected', { sheetUrl: window.collabState.sheetUrl });
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!window.collabState.connected) {
            connectCollabWebSocket();
        } else {
            emitCollabLocal('connection:reconnected', { sheetUrl: window.collabState.sheetUrl });
            emitCollabLocal('collab:reconnected', { sheetUrl: window.collabState.sheetUrl });
        }
    }
});

// Start WebSocket connection immediately
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connectCollabWebSocket);
} else {
    connectCollabWebSocket();
}

async function apiCall(action, data = {}, maxRetries = 2) {
    let delay = 1200;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                body: JSON.stringify({
                    action: action,
                    data: data,
                    clientId: window.collabClientId
                }),
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                redirect: 'follow'
            });

            const text = await response.text();
            try {
                const parsed = JSON.parse(text);
                return parsed;
            } catch (e) {
                if (attempt < maxRetries) {
                    console.warn(`API Response is not JSON (Attempt ${attempt + 1}). Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 1.5;
                    continue;
                }
                console.error("API Response is not JSON:", text);
                return { success: false, message: "Server Error: Invalid Response. Contact Support." };
            }
        } catch (error) {
            if (attempt < maxRetries) {
                console.warn(`API Error (Attempt ${attempt + 1}). Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5;
                continue;
            }
            console.error("API Error:", error);
            return { success: false, message: "Connection Error. Please check internet." };
        }
    }
}
