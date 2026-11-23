import { PRESET } from './config.js';

// El service worker: al instalar, guarda la dirección y la llave que trae la
// extensión descargada desde Canvian, y pone el menú contextual del recortador.

chrome.runtime.onInstalled.addListener(async () => {
  // La extensión descargada desde Canvian trae la dirección y la llave puestas.
  const saved = await chrome.storage.local.get(['url', 'token']);
  if (!saved.url && PRESET.url) await chrome.storage.local.set({ url: PRESET.url, token: PRESET.token });
  if (!saved.url && !PRESET.url) chrome.runtime.openOptionsPage();

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'clip-selection', title: 'Guardar lo seleccionado en Canvian', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'clip-page', title: 'Guardar esta página en Canvian', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'clip-link', title: 'Guardar el enlace en Canvian', contexts: ['link'] });
  });
});

// El menú contextual abre el recortador con el modo elegido.
chrome.contextMenus.onClicked.addListener(async (info) => {
  const mode = info.menuItemId === 'clip-selection' ? 'selection' : info.menuItemId === 'clip-link' ? 'link' : 'page';
  await chrome.storage.session.set({ pendingClip: { mode, link: info.linkUrl ?? null, text: info.selectionText ?? null, at: Date.now() } });
  try {
    await chrome.action.openPopup();
  } catch {
    // Chrome antiguo: el modo queda guardado para cuando se abra el popup.
  }
});
