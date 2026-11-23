// Iconos SVG propios (estáticos). `icon('mic', 20)` devuelve un <svg>.
const P = {
  hash: '<path d="M5 9h14M5 15h14M10.2 4 8.2 20M15.8 4l-2 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
  speaker: '<path d="M11.4 3.1a1 1 0 0 0-1.1.2L6 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h3l4.3 4.7A1 1 0 0 0 12 20V4a1 1 0 0 0-.6-.9Z"/><path d="M15.5 8.6a5 5 0 0 1 0 6.8M18.4 5.7a9 9 0 0 1 0 12.6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
  mic: '<rect x="8.5" y="2.5" width="7" height="12" rx="3.5"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
  micOff: '<rect x="8.5" y="2.5" width="7" height="12" rx="3.5"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M3.5 3.5l17 17" stroke="var(--slash,currentColor)" stroke-width="2.4" stroke-linecap="round"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><rect x="2.5" y="13" width="4.5" height="8" rx="2"/><rect x="17" y="13" width="4.5" height="8" rx="2"/>',
  headphonesOff: '<path d="M4 15v-3a8 8 0 0 1 16 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><rect x="2.5" y="13" width="4.5" height="8" rx="2"/><rect x="17" y="13" width="4.5" height="8" rx="2"/><path d="M3.5 3.5l17 17" stroke="var(--slash,currentColor)" stroke-width="2.4" stroke-linecap="round"/>',
  cog: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"/>',
  hangup: '<path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.3 11.3 0 0 0-2.67-1.85.99.99 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9Z"/>',
  screen: '<path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.11-.9-2-2-2H4c-1.11 0-2 .89-2 2v10c0 1.1.89 2 2 2H0v2h24v-2h-4Zm-7-3.53v-2.19c-2.78 0-4.61.85-6 2.72.56-2.67 2.11-5.33 6-5.87V7l4 3.73-4 3.74Z"/>',
  plus: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2Z"/>',
  people: '<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3Zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5Zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z"/>',
  chevron: '<path d="M7 10l5 5 5-5z"/>',
  chevronRight: '<path d="M10 7l5 5-5 5z"/>',
  close: '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12Z"/>',
  signal: '<rect x="3" y="14" width="4" height="7" rx="1"/><rect x="10" y="9" width="4" height="12" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/>',
  trash: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z"/>',
  download: '<path d="M19 9h-4V3H9v6H5l7 7 7-7ZM5 18v2h14v-2H5Z"/>',
  volume: '<path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4Z"/>',
  logo: '<path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>',
  image: '<path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z"/>'
}

export function icon(name, size = 20) {
  const t = document.createElement('template')
  t.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${P[name]}</svg>`
  return t.content.firstChild
}
