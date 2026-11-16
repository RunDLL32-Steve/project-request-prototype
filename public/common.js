// Shared browser helpers: Entra SSO (MSAL) sign-in, authenticated fetch, env banner.
const MSAL_URL = "https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.28.1/lib/msal-browser.min.js";

let msalApp = null;
let authConfig = null;
let account = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load " + src));
    document.head.appendChild(s);
  });
}

export async function initAuth() {
  authConfig = await (await fetch("/api/auth/config")).json();
  if (authConfig.env && authConfig.env !== "prod") {
    const b = document.createElement("div");
    b.className = "env-banner";
    b.textContent = authConfig.env === "nonprod" ? "NON-PROD ENVIRONMENT — test data only" : "LOCAL DEV";
    document.body.prepend(b);
  }
  if (authConfig.devAuth) return;
  if (!authConfig.clientId) throw new Error("SSO is not configured on the server.");
  await loadScript(MSAL_URL);
  msalApp = new msal.PublicClientApplication({
    auth: {
      clientId: authConfig.clientId,
      authority: `https://login.microsoftonline.com/${authConfig.tenantId}`,
      redirectUri: window.location.origin + window.location.pathname,
    },
    cache: { cacheLocation: "sessionStorage" },
  });
  await msalApp.initialize();
  const result = await msalApp.handleRedirectPromise();
  account = result?.account || msalApp.getAllAccounts()[0] || null;
  if (!account) {
    await msalApp.loginRedirect({ scopes: [authConfig.scope] });
    await new Promise(() => {}); // page navigates away
  }
}

async function getToken() {
  if (!msalApp) return null;
  try {
    return (await msalApp.acquireTokenSilent({ scopes: [authConfig.scope], account })).accessToken;
  } catch {
    await msalApp.acquireTokenRedirect({ scopes: [authConfig.scope], account });
    await new Promise(() => {});
  }
}

export async function api(path, options = {}) {
  const token = await getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
