import { api, getConfig, originPattern, setConfig } from '../lib/api.js';
import { refreshStyle, startStyle } from '../lib/style.js';
import { combo } from '../lib/controls.js';

const $ = (id) => document.getElementById(id);

async function showProfiles() {
  const { profile } = await getConfig();
  const { profiles, active } = await api('/profiles');
  const activeName = profiles.find((p) => p.id === active)?.name ?? '';
  const items = [{ id: '', label: `El que tengas abierto en Canvian (ahora ${activeName})` }, ...profiles.map((p) => ({ id: p.id, label: p.name }))];
  profileField.setItems(items);
  profileField.set(profiles.some((p) => p.id === profile) ? profile : '');
  $('profile-box').hidden = false;
  return profiles;
}

async function start() {
  const cfg = await getConfig();
  $('url').value = cfg.url;
  $('token').value = cfg.token;
  if (cfg.url && cfg.token) {
    try {
      await showProfiles();
      $('status').textContent = 'Conectada';
      $('status').className = 'cx-ok';
    } catch (e) {
      $('status').textContent = e.message;
      $('status').className = 'cx-error';
    }
  }
}

$('save').addEventListener('click', async () => {
  const url = $('url').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  $('status').className = 'cx-muted';
  if (!/^https?:\/\/[^\s/]+/.test(url)) {
    $('status').textContent = 'Escribe la dirección entera, con http:// o https://';
    return;
  }
  // Permiso para hablar con esa dirección (lo pide Chrome una vez).
  const granted = await chrome.permissions.request({ origins: [originPattern(url)] }).catch(() => false);
  if (!granted) {
    $('status').textContent = 'Sin permiso para esa dirección la extensión no puede llegar a Canvian.';
    $('status').className = 'cx-error';
    return;
  }
  await setConfig({ url, token });
  $('status').textContent = 'Probando…';
  try {
    const profiles = await showProfiles();
    $('status').textContent = `Conectada · ${profiles.length} perfiles`;
    refreshStyle();
    $('status').className = 'cx-ok';
  } catch (e) {
    $('status').textContent = e.message;
    $('status').className = 'cx-error';
  }
});

const profileField = combo({
  label: 'Perfil',
  onChange: async (v) => {
    await setConfig({ profile: v || null });
    refreshStyle();
  },
});
$('profile').append(profileField.el);

startStyle();
start();
