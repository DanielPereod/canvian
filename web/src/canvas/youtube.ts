// Enlaces de YouTube: qué vídeo es, y si un texto pide verlo incrustado.

export function youtubeId(url: string): { id: string; start: number } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(u.pathname)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  // ?t=90, ?t=1m30s o ?start=90: empieza ahí.
  const t = u.searchParams.get('t') ?? u.searchParams.get('start') ?? '';
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  const start = m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  return { id, start };
}

// La sintaxis de incrustar de Markdown y Obsidian: ![texto](url), !<url> y
// ![[url]]. Si lo que incrusta es un vídeo de YouTube, devuelve su dirección.
const EMBED = [
  /^!\[[^\]\n]*\]\(\s*<?([^\s<>()]+)>?(?:\s+"[^"]*")?\s*\)$/,
  /^!<([^\s<>]+)>$/,
  /^!\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]$/,
];
export function youtubeEmbed(text: string): string | null {
  const s = text.trim();
  for (const re of EMBED) {
    const url = re.exec(s)?.[1].trim();
    if (url && youtubeId(url)) return url;
  }
  return null;
}

// Lo que se escribe al exportar: Obsidian también lo enseña como el vídeo.
export const youtubeMarkdown = (src: string) => `![](${src})`;
