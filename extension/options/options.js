import { api, getConfig, originPattern, setConfig } from '../lib/api.js';
import { refreshStyle, startStyle } from '../lib/style.js';

const $ = (id) => document.getElementById(id);

async function showProfiles() {
  const { profile } = await getConfig();
  const { profiles } = await api('/profiles');
  const sel = $('profile');
  sel.textContent = '';
  for (const p of profiles) sel.append(new Option(p.name, p.id));
  sel.value = profiles.some((p) => p.id === profile) ? profile : profiles[0]?.id;
  if (!profile && profiles[0]) await setConfig({ profile: profiles[0].id });
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

$('profile').addEventListener('change', async (e) => {
  await setConfig({ profile: e.target.value });
  refreshStyle();
});

startStyle();
start();
