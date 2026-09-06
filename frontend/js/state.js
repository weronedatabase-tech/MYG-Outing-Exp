// Global Application State Variables
let currentSheetList = [];
let selectedVolType = null;
let allNames = [];
let allProjects = []; 
let currentVolTypeRequest = null;

// Synchronously restore admin auth state for the current session to avoid UI flicker
let isAdminAuthenticated = false;
try {
    const savedKey = localStorage.getItem('adminKey');
    const validatedKey = sessionStorage.getItem('adminKeyValidated');
    if (savedKey && savedKey === validatedKey) {
        isAdminAuthenticated = true;
    }
} catch(e) {}

let pendingView = "";
let pendingAction = null;
let currentActiveView = 'landing';
let outingReminders = {};

// Idle-Time Hydration State
let isHydrated = false;
let hydratedEventUrl = null;

// Setting defaults
const DEF_SHARE_FORMAT = "{{Groups}} | {{Meetings}} | {{Dismissals}} | Total: {{Count}}\n\n{{List}}";
let appSettings = null;