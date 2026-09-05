const express = require('express');
const path = require('path');
const config = require('./backend/config.js');
const NodeCache = require('node-cache');
const fetch = require('node-fetch'); // fallback for older Node, or global fetch in Node 18+

const app = express();
const port = 3000;

// Use global fetch
const _fetch = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

// Setup cache (15 seconds TTL for read operations to handle burst concurrency)
const cache = new NodeCache({ stdTTL: 15, checkperiod: 15 });

// In-flight request tracker to collapse duplicate concurrent requests
const inFlightRequests = new Map();

// Concurrency queue for write requests to avoid hitting GAS limits
class AsyncQueue {
    constructor(concurrency = 3) {
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
}

const writeQueue = new AsyncQueue(3); // Process max 3 writes concurrently to GAS

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

app.use(express.text({ type: '*/*', limit: '50mb' })); // GAS clients usually send JSON as text

app.post('/api', async (req, res) => {
    let parsedBody;
    try {
        parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch(e) {
        return res.status(400).json({ success: false, message: 'Invalid JSON body' });
    }

    const { action, data } = parsedBody;
    if (!action) {
         return res.status(400).json({ success: false, message: 'Missing action' });
    }

    if (action === 'forceBackendRefresh') {
        console.log(`[CACHE CLEARED] via forceBackendRefresh`);
        cache.flushAll();
        // Continue to queue the action to GAS as a write action
    }

    const isRead = READ_ACTIONS.includes(action);
    const cacheKey = isRead ? action + '_' + JSON.stringify(data || {}) : null;

    if (isRead) {
        // 1. Check Cache
        const cachedResponse = cache.get(cacheKey);
        if (cachedResponse) {
            console.log(`[CACHE HIT] ${action}`);
            return res.json(cachedResponse);
        }

        // 2. Check if request is already in-flight
        if (inFlightRequests.has(cacheKey)) {
            console.log(`[COLLAPSE] Waiting for in-flight ${action}`);
            try {
                const response = await inFlightRequests.get(cacheKey);
                return res.json(response);
            } catch (err) {
                return res.status(500).json({ success: false, message: 'Server Error' });
            }
        }

        // 3. Fetch from GAS
        console.log(`[FETCH] Executing ${action} to GAS`);
        const fetchPromise = (async () => {
            const gasResponse = await _fetch(config.GAS_BACKEND_URL, {
                method: 'POST',
                body: JSON.stringify({ action, data }),
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                redirect: 'follow'
            });
            const text = await gasResponse.text();
            try {
                const parsed = JSON.parse(text);
                // Only cache successful reads
                if (parsed.success !== false) {
                     cache.set(cacheKey, parsed);
                }
                return parsed;
            } catch (e) {
                throw new Error("Invalid JSON from GAS: " + text.substring(0, 100));
            }
        })();

        inFlightRequests.set(cacheKey, fetchPromise);

        try {
            const response = await fetchPromise;
            return res.json(response);
        } catch (err) {
            console.error(`[ERROR] ${action}:`, err.message);
            return res.status(500).json({ success: false, message: 'Server Error contacting backend' });
        } finally {
            inFlightRequests.delete(cacheKey);
        }
    } else {
        // Write Actions - queue them to avoid rate limiting
        console.log(`[QUEUE] Enqueueing write action: ${action}`);
        try {
            const response = await writeQueue.add(async () => {
                const gasResponse = await _fetch(config.GAS_BACKEND_URL, {
                    method: 'POST',
                    body: JSON.stringify({ action, data }),
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    redirect: 'follow'
                });
                const text = await gasResponse.text();
                return JSON.parse(text);
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
  console.log(`Proxying API requests to GAS: ${config.GAS_BACKEND_URL}`);
});
