// Whether this browser is probably signed in, known before Privy has loaded,
// so a reload shows the splash instead of a flash of the landing page.
//
// - SESSION_COOKIE is ours: set once Privy confirms a sign-in, cleared when it
//   confirms there's none. The server reads it and renders the splash.
// - BOOT_SCRIPT runs in <head> before the first paint. If Privy left a
//   session in storage but our cookie isn't there yet, it hides the landing
//   page until the dashboard takes over (and sets the cookie for next time).

export const SESSION_COOKIE = 'cult_session';
export const BOOT_CLASS = 'cult-boot';

// Privy's tokens: privy:token / privy:refresh_token, or privy:<user>:... when
// it keeps several users. Also counted: the demo, and coming back from
// Google sign-in.
const PRIVY_TOKEN = /^privy:(?:[^:]+:)?(?:refresh_)?token$/;

export function hasStoredSession(): boolean {
  // Back from Google sign-in: Privy is about to finish it.
  if (new URLSearchParams(window.location.search).has('privy_oauth_code')) return true;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && PRIVY_TOKEN.test(key) && window.localStorage.getItem(key)) return true;
    }
  } catch { /* storage blocked: no hint */ }
  return false;
}

export function markSession(signedIn: boolean) {
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = signedIn
    ? `${SESSION_COOKIE}=1; path=/; max-age=31536000; samesite=lax${secure}`
    : `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
}

export const BOOT_SCRIPT = `try{var s=localStorage,r=${PRIVY_TOKEN},k,i=0,y=sessionStorage.getItem('cult:demo')==='1'||location.search.indexOf('privy_oauth_code=')>=0;for(;!y&&i<s.length;i++){k=s.key(i);if(k&&r.test(k)&&s.getItem(k))y=1}if(y&&document.cookie.indexOf('${SESSION_COOKIE}=1')<0)document.documentElement.classList.add('${BOOT_CLASS}')}catch(e){}`;
