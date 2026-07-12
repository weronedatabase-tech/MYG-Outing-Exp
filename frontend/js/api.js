/**
* API Caller Wrapper
* Uses API_URL globally defined in backend/config.js
*/
async function apiCall(action, data = {}) {
  try {
      const bodyStr = JSON.stringify({ action: action, data: data });
      // keepalive: true ensures the browser completes the request even if the tab is closed.
      // Limited to < 60KB per browser specs (skips for heavy payloads like image exports).
      const useKeepAlive = bodyStr.length < 60000;
      
      const response = await fetch(API_URL, {
          method: 'POST',
          body: bodyStr,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          redirect: 'follow',
          keepalive: useKeepAlive
      });
      
      const text = await response.text();
      try {
          return JSON.parse(text);
      } catch (e) {
          console.error("API Response is not JSON:", text);
          return { success: false, message: "Server Error: Invalid Response. Contact Support." };
      }
  } catch (error) {
      console.error("API Error:", error);
      return { success: false, message: "Connection Error. Please check internet." };
  }
}