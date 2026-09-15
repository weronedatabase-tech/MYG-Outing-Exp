const fetch = require('node-fetch');

async function test() {
    console.log("Fetching POST to GAS_BACKEND_URL...");
    const url = 'https://script.google.com/macros/s/AKfycby16sDgMLOCkZah70i3GV50aAbNIVcQ9GEYDx83YZjJkoK49FXbw-_tgqE0emQfB0TISw/exec';
    
    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ action: "getAppSettings" }),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        redirect: 'follow'
    });
    
    const text = await response.text();
    console.log("Status:", response.status);
    console.log("Body length:", text.length);
    console.log("First 100 chars:", text.substring(0, 100));
}

test();
