const fs = require('fs');
let code = fs.readFileSync('frontend/js/volunteer.js', 'utf8');

const target = `showOverlay('loading', 'Saving Attendance...');

const payload = { sheetUrl: document.getElementById('volSheetSelector').value, type: selectedVolType, data: deltaObj, targetName: target }; 

apiCall('submitAttendanceData', payload).then(res => { 
if(res.success) {
    showOverlay('success', res.message);
    if(selectedVolType === 'volunteer') { 
        if(res.message.includes("added")) { 
            resetVolForm();
            document.getElementById('volNameSearch').value = "";
        } 
        const url = document.getElementById('volSheetSelector').value; 
        setTimeout(() => {
            apiCall('getNamesList', { url: url, type: 'volunteer' }).then(r => { if(r.success) allNames = r.names; }); 
        }, 500);
    } 
} else {
    showOverlay('error', res.message);
}
}); `;

const replacement = `// Optimistic UI: Show success instantly
showOverlay('success', 'Attendance submitted securely.');
const url = document.getElementById('volSheetSelector').value;
const isNewAddition = document.getElementById('formTitle').innerText.includes("Add New");

if (selectedVolType === 'volunteer' && isNewAddition) {
    resetVolForm();
    document.getElementById('volNameSearch').value = "";
}

setTimeout(() => { closeOverlay(); }, 1200);

const payload = { sheetUrl: url, type: selectedVolType, data: deltaObj, targetName: target }; 

// Background sync (Fire and forget)
apiCall('submitAttendanceData', payload).then(res => { 
    if(res.success) {
        if(selectedVolType === 'volunteer') { 
            apiCall('getNamesList', { url: url, type: 'volunteer' }).then(r => { if(r.success) allNames = r.names; }); 
        } 
    } else {
        console.error("Background sync failed:", res.message);
        setTimeout(() => showOverlay('error', "Sync Error: " + res.message), 500);
    }
}).catch(e => console.error("Sync Error", e));`;

code = code.replace(target, replacement);
fs.writeFileSync('frontend/js/volunteer.js', code);
