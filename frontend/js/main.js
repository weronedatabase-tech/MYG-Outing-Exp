document.addEventListener("DOMContentLoaded", () => {
    if(localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    const envBar = document.getElementById('envBar');
    if (envBar) {
        if (ENV === 'Dev') {
            envBar.innerText = 'Testing';
            envBar.classList.add('bg-red-600', 'border-red-800');
            envBar.classList.remove('hidden');
        } else if (ENV === 'Exp') {
            envBar.innerText = 'Experimentation';
            envBar.classList.add('bg-purple-600', 'border-purple-800');
            envBar.classList.remove('hidden');
        }
    }

    console.log(`Running in ${ENV} mode connected to: ${API_URL}`);

    apiCall('getAppSettings', null).then(res => {
        if (res && res.success !== false) {
            appSettings = res;
        }
    });

    const savedKey = localStorage.getItem('adminKey');
    if (savedKey) {
        apiCall('verifyAdminPassword', savedKey).then(isValid => {
            if (isValid) {
                isAdminAuthenticated = true;
            } else {
                localStorage.removeItem('adminKey');
                isAdminAuthenticated = false;
            }
        });
    }

    silentHydration();
});

function silentHydration() {
    if (isHydrated) return;
    
    apiCall('getRecentOutingSheets', null).then(res => {
        if (res && res.success && res.data && res.data.length > 0) {
            currentSheetList = res.data;
            localStorage.setItem('myg_sheetList', JSON.stringify(res.data)); // Core MPA Pre-cache
            isHydrated = true;
        }
    }).catch(e => console.warn("Hydration failed silently", e));
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').then(reg => {
            console.log('Service Worker Registered successfully');
        }).catch(err => {
            console.warn('Service Worker registration failed:', err);
        });
    });
}