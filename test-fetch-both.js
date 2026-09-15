const nodeFetch = require('node-fetch');
const globalFetch = fetch;

async function test(fetcher, name) {
    const url = 'https://script.google.com/macros/s/AKfycby16sDgMLOCkZah70i3GV50aAbNIVcQ9GEYDx83YZjJkoK49FXbw-_tgqE0emQfB0TISw/exec';
    console.log(`\nTesting ${name}...`);
    try {
        const response = await fetcher(url, {
            method: 'POST',
            body: JSON.stringify({ action: "getNamesList", data: {url: "dummy", type: "volunteer"} }),
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            redirect: 'follow'
        });
        const text = await response.text();
        console.log("Status:", response.status);
        console.log("Response:", text);
    } catch(e) {
        console.error(e);
    }
}
async function run() {
    await test(nodeFetch, "node-fetch");
    await test(globalFetch, "global fetch");
}
run();
