const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const target = `                const text = await gasResponse.text();
                return JSON.parse(text);
            });`;

const replacement = `                const text = await gasResponse.text();
                // Flush cache AGAIN after the write completes to clear any stale reads that snuck in
                cache.flushAll();
                return JSON.parse(text);
            });`;

code = code.replace(target, replacement);
fs.writeFileSync('server.js', code);
