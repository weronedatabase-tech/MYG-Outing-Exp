const fs = require('fs');
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
console.log = function(...args) {
    fs.appendFileSync('server_runtime.log', args.join(' ') + '\n');
    originalConsoleLog.apply(console, args);
};
console.error = function(...args) {
    fs.appendFileSync('server_runtime.log', 'ERROR: ' + args.join(' ') + '\n');
    originalConsoleError.apply(console, args);
};
