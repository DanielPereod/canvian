import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { parseCard } from '../src/routes/unfurl.js';
import type { Fetcher } from '../src/calendars.js';

const PAGE = `<!doctype html><html><head>
<title>Título de reserva</title>
<meta property="og:title" content="Rebalanceo de cartera &amp; riesgo">
<meta name="description" content="Cómo y cuándo rebalancear.">
<meta property="og:image" content="/img/portada.png">
<meta property="og:site_name" content="Finanzas">
</head><body>…</body></html>`;

describe('ficha de un enlace', () => {
  it('lee Open Graph y hace absoluta la imagen', () => {
    expect(parseCard(PAGE, 'https://ejemplo.com/articulo')).toEqual({
      url: 'https://ejemplo.com/articulo',
      title: 'Rebalanceo de cartera & riesgo',
      description: 'Cómo y cuándo rebalancear.',
      image: 'https://ejemplo.com/img/portada.png',
      site: 'Finanzas',
    });
  });

  it('sin Open Graph usa <title> y el dominio', () => {
    const card = parseCard('<head><title> Hola </title></head>', 'https://www.sitio.dev/x');
    expect(card.title).toBe('Hola');
    expect(card.site).toBe('sitio.dev');
    expect(card.image).toBeNull();
  });
});

describe('GET /api/unfurl', () => {
  let app: ReturnType<typeof createApp>;
  let cookie = '';
  let asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const get = (url: string) => app.request(`/api/unfurl?url=${encodeURIComponent(url)}`, { headers: cookie ? { cookie } : {} });

  beforeEach(async () => {
    asked = [];
    app = createApp(openDb(':memory:'), { fetchPage: fetcher });
    const res = await app.request('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'una-clave-larga' }) });
    cookie = res.headers.get('set-cookie')!.split(';')[0];
  });

  it('devuelve la ficha y la recuerda', async () => {
    const a = await (await get('https://ejemplo.com/a')).json();
    expect(a.title).toBe('Rebalanceo de cartera & riesgo');
    await get('https://ejemplo.com/a');
    expect(asked).toEqual(['https://ejemplo.com/a']);
  });

  it('no pide direcciones de la red de casa', async () => {
    for (const url of ['http://localhost:3210/', 'http://192.168.0.100/', 'http://10.0.0.1/', 'http://servidor/', 'file:///etc/passwd']) expect((await get(url)).status).toBe(400);
    expect(asked).toEqual([]);
  });

  it('pide sesión', async () => {
    cookie = '';
    expect((await get('https://ejemplo.com/a')).status).toBe(401);
  });
});
