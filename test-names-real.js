const fetch = require('node-fetch');
async function test() {
    const url = 'https://script.google.com/macros/s/AKfycby16sDgMLOCkZah70i3GV50aAbNIVcQ9GEYDx83YZjJkoK49FXbw-_tgqE0emQfB0TISw/exec';
    const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ action: "getNamesList", data: {url: "https://docs.google.com/spreadsheets/d/1Xy_bA_3tH-T8s9VwQ64z9G_8R7sUfXq8N35q74q0E3M/edit", type: "volunteer"} }),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        redirect: 'follow'
    });
    const text = await response.text();
    console.log("Status:", response.status);
    console.log("Response length:", text.length);
    console.log("Response:", text.substring(0, 100));
}
test();
