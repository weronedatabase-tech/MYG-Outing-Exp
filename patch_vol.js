const fs = require('fs');
let code = fs.readFileSync('frontend/js/volunteer.js', 'utf8');

const target = `// Invalidate the cache for this person so it pulls fresh next time
const cacheKey = \`\${selectedVolType}_\${target || 'NEW'}\`;
delete personDataCache[cacheKey];`;

const replacement = `// Optimistically update the local cache so re-selecting is instant and shows the new state
const cacheKey = \`\${selectedVolType}_\${target || 'NEW'}\`;
if (personDataCache[cacheKey]) {
    personDataCache[cacheKey] = personDataCache[cacheKey].then(oldRes => {
        if (oldRes && oldRes.success) {
            let newRes = JSON.parse(JSON.stringify(oldRes));
            for (let k in deltaObj) {
                newRes.data[k] = deltaObj[k];
            }
            return newRes;
        }
        return oldRes;
    });
}`;

code = code.replace(target, replacement);
fs.writeFileSync('frontend/js/volunteer.js', code);
