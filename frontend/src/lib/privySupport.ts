// Privy refuses to start anywhere but https:// or localhost (it throws while
// rendering). Opening the dev server from a phone on the same Wi-Fi uses
// http://<this PC's IP>, so there we run without Privy: the demo works, and
// sign-in explains that it needs a secure connection. The server renders as
// if supported; the page markup is the same either way.
export const privySupported = () =>
  typeof window === 'undefined'
  || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  || window.location.protocol === 'https:';
