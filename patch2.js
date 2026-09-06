const fs = require('fs');
let code = fs.readFileSync('frontend/js/volunteer.js', 'utf8');

const target = `// Optimistic UI: Show success instantly
showOverlay("success", "Attendance submitted securely.");
const url = document.getElementById("volSheetSelector").value;
const isNewAddition = document.getElementById("formTitle").innerText.includes("Add New");

if (selectedVolType === "volunteer" && isNewAddition) {
    resetVolForm();
    document.getElementById("volNameSearch").value = "";
}

setTimeout(() => { closeOverlay(); }, 1200);`;

const replacement = `// Optimistic UI: Show success instantly
showOverlay("success", "Attendance submitted securely.");
const url = document.getElementById("volSheetSelector").value;
const isNewAddition = document.getElementById("formTitle").innerText.includes("Add New");

// Invalidate the cache for this person so it pulls fresh next time
const cacheKey = \`\${selectedVolType}_\${target || 'NEW'}\`;
delete personDataCache[cacheKey];

if (selectedVolType === "volunteer" && isNewAddition) {
    resetVolForm();
    document.getElementById("volNameSearch").value = "";
} else {
    // If we're updating an existing person, we could also hide the form
    document.getElementById('volFormContainer').classList.add('hidden');
    document.getElementById("volNameSearch").value = "";
    toggleClearBtn('volNameSearch');
}

setTimeout(() => { closeOverlay(); }, 1200);`;

code = code.replace(target, replacement);
fs.writeFileSync('frontend/js/volunteer.js', code);
