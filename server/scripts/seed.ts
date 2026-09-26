// Llena los perfiles con notas de ejemplo para probar el lienzo con datos.
//
//   npm run seed                 añade el ejemplo a Personal y Trabajo
//   npm run seed -- --extra 400  además, 400 notas sueltas para medir rendimiento
//   npm run seed -- --borrar     quita todo lo que añadió este script
//
// Usa la misma base de datos que el servidor (CANVIAN_DB o server/data/canvian.db).
// Todo lo que crea lleva `"ejemplo": true` en sus propiedades para poder borrarlo.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { openDb } from '../src/db/index.js';
import { edges, notes, profiles } from '../src/db/schema.js';

type Item = { t: string; body?: string | string[]; task?: 'todo' | 'doing' | 'done' };
type Zone = { name: string; items: Item[] };

const PERSONAL: Zone[] = [
  {
    name: 'Viaje a Japón',
    items: [
      { t: 'Plan de viaje a Japón', body: 'Dos semanas en primavera, idealmente para ver los cerezos.' },
      { t: 'Comprar billetes de avión', task: 'done' },
      { t: 'Reservar ryokan en Kioto', task: 'doing', body: 'Mirar los que tienen onsen privado.' },
      { t: 'JR Pass: ¿merece la pena?', body: ['Calcular trayectos largos', 'Comparar con billetes sueltos', 'Ver la subida de precio'] },
      { t: 'Ruta', body: ['Tokio · 4 días', 'Hakone · 1 día', 'Kioto · 4 días', 'Nara · excursión', 'Osaka · 3 días'] },
      { t: 'Frases básicas en japonés', body: 'Sumimasen, arigatō gozaimasu, kore wa ikura desu ka.' },
      { t: 'Tarjeta Suica en el móvil', task: 'todo' },
      { t: 'Seguro de viaje', task: 'todo' },
      { t: 'Templos imprescindibles', body: ['Fushimi Inari al amanecer', 'Kiyomizu-dera', 'Kinkaku-ji', 'Tōdai-ji'] },
      { t: 'Comida que probar', body: 'Okonomiyaki en Osaka, ramen en Fukuoka si da tiempo, kaiseki en Kioto.' },
      { t: 'Presupuesto del viaje', body: 'Unos 3.500 € entre dos, sin contar compras.' },
      { t: 'Adaptador de enchufe tipo A', task: 'done' },
      { t: 'Descargar mapas offline', task: 'todo' },
      { t: 'Museo Ghibli: entradas', task: 'doing', body: 'Salen a la venta el día 10 de cada mes.' },
    ],
  },
  {
    name: 'Casa',
    items: [
      { t: 'Reforma del baño', body: 'Pedir tres presupuestos antes de decidir.' },
      { t: 'Llamar al fontanero', task: 'done' },
      { t: 'Elegir azulejos', task: 'doing', body: ['Verde salvia', 'Terrazo claro', 'Blanco roto mate'] },
      { t: 'Cambiar bombillas a luz cálida', task: 'todo' },
      { t: 'Plantas del balcón', body: 'Regar la albahaca cada dos días, el romero una vez a la semana.' },
      { t: 'Arreglar la persiana del salón', task: 'todo' },
      { t: 'Seguro del hogar vence en marzo', task: 'todo' },
      { t: 'Ideas para el estudio', body: ['Estantería de pared', 'Lámpara de pie', 'Alfombra de lana'] },
      { t: 'Vender la bici vieja', task: 'done' },
      { t: 'Limpieza de primavera', body: 'Armarios, trastero y la terraza.' },
      { t: 'Revisar la caldera', task: 'doing' },
      { t: 'Facturas de la luz', body: 'Comparar tarifa fija con la de discriminación horaria.' },
    ],
  },
  {
    name: 'Lecturas',
    items: [
      { t: 'Lista de lectura 2026', body: 'Un libro al mes, alternando ficción y ensayo.' },
      { t: 'Pedro Páramo', body: 'Releer. Cómo Rulfo borra la frontera entre vivos y muertos.' },
      { t: 'El infinito en un junco', task: 'doing', body: 'Voy por la parte de la biblioteca de Alejandría.' },
      { t: 'Cien años de soledad', task: 'done' },
      { t: 'Thinking in Systems', body: 'Stocks, flujos y bucles de realimentación. Muy aplicable al trabajo.' },
      { t: 'Citas que me gustan', body: '«Lo esencial es invisible a los ojos.»' },
      { t: 'Ficciones de Borges', task: 'todo' },
      { t: 'The Creative Act', body: 'Rick Rubin: la creatividad como forma de estar atento.' },
      { t: 'Club de lectura: próximo libro', task: 'todo' },
      { t: 'Cuadernos de notas de Da Vinci', body: 'Inspiración para este mismo lienzo.' },
      { t: 'La sociedad del cansancio', task: 'done' },
    ],
  },
  {
    name: 'Salud',
    items: [
      { t: 'Rutina de mañana', body: ['Agua con limón', '10 min de estiramientos', 'Paseo corto sin móvil'] },
      { t: 'Correr 3 días por semana', task: 'doing' },
      { t: 'Cita con el dentista', task: 'done' },
      { t: 'Análisis de sangre anual', task: 'todo' },
      { t: 'Meditación', body: 'Probar 10 minutos antes de dormir durante un mes.' },
      { t: 'Recetas altas en proteína', body: 'Lentejas con verduras, tortilla de claras, hummus casero.' },
      { t: 'Dormir antes de las 12', task: 'doing' },
      { t: 'Revisión de la vista', task: 'todo' },
      { t: 'Yoga los domingos', body: 'Clase en el parque a las 10.' },
    ],
  },
  {
    name: 'Cocina',
    items: [
      { t: 'Recetas para probar', body: 'Una receta nueva cada fin de semana.' },
      { t: 'Ramen casero', body: ['Caldo tonkotsu 12 h', 'Huevo marinado', 'Chashu', 'Nori y cebolleta'] },
      { t: 'Pan de masa madre', task: 'doing', body: 'La masa madre ya tiene nombre: Paco.' },
      { t: 'Comprar cuchillo japonés', task: 'todo' },
      { t: 'Gazpacho de la abuela', body: 'Tomate de pera, pepino, pimiento verde, ajo, AOVE y un poco de pan.' },
      { t: 'Curry verde tailandés', task: 'done' },
      { t: 'Organizar la despensa', task: 'todo' },
      { t: 'Fermentados', body: 'Kimchi, chucrut y kombucha. Empezar por el chucrut.' },
      { t: 'Menú de la cena del sábado', task: 'todo', body: ['Burrata con tomate', 'Risotto de setas', 'Tarta de queso'] },
    ],
  },
  {
    name: 'Ideas sueltas',
    items: [
      { t: 'Canvian como diario visual', body: 'Una zona por mes con lo que he aprendido.' },
      { t: 'Aprender a tocar el piano', task: 'todo' },
      { t: 'Newsletter personal', body: 'Escribir una vez al mes sobre lo que leo y construyo.' },
      { t: 'Fotografía analógica', body: 'Recuperar la cámara del abuelo y comprar un carrete Portra 400.' },
      { t: 'Huerto urbano', body: 'Tomates cherry, lechuga y fresas en la terraza.' },
      { t: 'Regalo de cumpleaños para Ana', task: 'doing' },
      { t: 'Curso de cerámica', task: 'todo' },
      { t: 'Mapa de las cosas que me dan energía', body: 'Caminar, cocinar para amigos, construir cosas pequeñas.' },
      { t: 'Hacer una web de recetas', body: 'Podría reutilizar ideas de este proyecto.' },
    ],
  },
];

const TRABAJO: Zone[] = [
  {
    name: 'Lanzamiento v2',
    items: [
      { t: 'Lanzamiento v2', body: 'Objetivo: salir antes de final de trimestre con la nueva app móvil.' },
      { t: 'Definir el alcance del MVP', task: 'done' },
      { t: 'Diseño de la pantalla de inicio', task: 'doing', body: 'Revisar con diseño el martes.' },
      { t: 'Migración de la base de datos', task: 'doing', body: ['Script de migración', 'Probar en staging', 'Plan de vuelta atrás'] },
      { t: 'Notas de la versión', task: 'todo' },
      { t: 'Plan de comunicación', body: 'Blog, newsletter y un hilo en redes el día del lanzamiento.' },
      { t: 'Beta cerrada con 50 usuarios', task: 'doing' },
      { t: 'Métricas de éxito', body: ['Activación > 40 %', 'Retención a 7 días > 25 %', 'NPS > 30'] },
      { t: 'Checklist de accesibilidad', task: 'todo' },
      { t: 'Revisión legal de los términos', task: 'todo' },
      { t: 'Pruebas de carga', task: 'done', body: '2.000 usuarios concurrentes sin errores.' },
      { t: 'Riesgos', body: 'Dependencia del proveedor de pagos; retrasos en la tienda de apps.' },
      { t: 'Fecha de lanzamiento', body: 'Tentativa: 18 de noviembre.' },
    ],
  },
  {
    name: 'Equipo',
    items: [
      { t: 'Uno a uno con Laura', body: 'Hablar de su plan de carrera y de la carga de trabajo.' },
      { t: 'Uno a uno con Marcos', task: 'todo' },
      { t: 'Contratar frontend senior', task: 'doing', body: ['Publicar oferta', 'Primera ronda de entrevistas', 'Prueba técnica'] },
      { t: 'Onboarding de Pablo', task: 'done' },
      { t: 'Offsite del equipo', body: 'Dos días en la sierra en octubre. Buscar casa rural.' },
      { t: 'Evaluaciones de desempeño', task: 'todo' },
      { t: 'Valores del equipo', body: 'Claridad, autonomía, cuidado por el detalle.' },
      { t: 'Retro del sprint 42', body: 'Lo bueno: menos reuniones. Lo mejorable: estimaciones.' },
      { t: 'Presupuesto de formación', task: 'todo' },
      { t: 'Rotación de guardias', task: 'done' },
    ],
  },
  {
    name: 'Reuniones',
    items: [
      { t: 'Reunión de producto semanal', body: 'Lunes 10:00. Revisar métricas y prioridades.' },
      { t: 'Acta: comité de dirección', body: ['Aprobado el presupuesto de Q4', 'Congelar contrataciones no críticas', 'Revisar precios en enero'] },
      { t: 'Preparar la demo del viernes', task: 'doing' },
      { t: 'Llamada con el cliente Acme', task: 'done', body: 'Quieren integración con su SSO.' },
      { t: 'Agenda del all-hands', task: 'todo' },
      { t: 'Seguimiento con marketing', task: 'todo' },
      { t: 'Revisión trimestral', body: 'Crecimiento del 18 %, por encima del objetivo.' },
      { t: 'Workshop de discovery', body: 'Mapear el recorrido del usuario nuevo de principio a fin.' },
    ],
  },
  {
    name: 'Investigación',
    items: [
      { t: 'Entrevistas con usuarios', body: 'Doce entrevistas hechas. Tema recurrente: exceso de notificaciones.' },
      { t: 'Síntesis de las entrevistas', task: 'doing' },
      { t: 'Análisis de la competencia', body: ['Notion', 'Obsidian Canvas', 'Heptabase', 'tldraw'] },
      { t: 'Encuesta de satisfacción', task: 'todo' },
      { t: 'Hipótesis: onboarding guiado', body: 'Si guiamos los primeros cinco minutos, la activación sube.' },
      { t: 'Test A/B del precio anual', task: 'done', body: 'El descuento del 20 % convierte mejor que el del 15 %.' },
      { t: 'Personas', body: 'La estudiante organizada, el freelance disperso, la jefa de equipo.' },
      { t: 'Mapa de oportunidades', task: 'todo' },
      { t: 'Estudio de usabilidad móvil', task: 'todo' },
    ],
  },
  {
    name: 'Backlog técnico',
    items: [
      { t: 'Actualizar a Node 22', task: 'done' },
      { t: 'Quitar dependencias sin uso', task: 'todo' },
      { t: 'Mejorar los tiempos del CI', task: 'doing', body: 'Caché de dependencias y tests en paralelo.' },
      { t: 'Logs estructurados', task: 'todo' },
      { t: 'Deuda: módulo de facturación', body: 'Nadie quiere tocarlo. Escribir tests antes de refactorizar.' },
      { t: 'Alertas de errores en producción', task: 'doing' },
      { t: 'Documentar la API pública', task: 'todo' },
      { t: 'Revisar permisos de la base de datos', task: 'todo' },
      { t: 'Arquitectura de eventos', body: 'Evaluar una cola ligera para desacoplar notificaciones.' },
      { t: 'Feature flags', task: 'done' },
    ],
  },
];

const LOOSE = [
  'Llamar a mamá',
  'Pensar en el regalo de aniversario',
  'Idea: modo oscuro para todo',
  'Revisar suscripciones que no uso',
  'Escribir más a mano',
  'Aprender atajos del teclado',
  'Mirar pisos en el centro',
  'Hacer copia de seguridad de las fotos',
  'Podcast recomendado por Luis',
  'Renovar el DNI',
];

const WORDS = ['idea', 'boceto', 'nota', 'pendiente', 'pregunta', 'recordatorio', 'hallazgo', 'cita', 'plan', 'duda'];
const TOPICS = ['diseño', 'viajes', 'lecturas', 'equipo', 'cocina', 'música', 'finanzas', 'salud', 'código', 'jardín'];

// Generador pseudoaleatorio con semilla para que el ejemplo salga siempre igual.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function doc(title: string, body?: string | string[]) {
  const content: unknown[] = [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: title }] }];
  if (typeof body === 'string') content.push({ type: 'paragraph', content: [{ type: 'text', text: body }] });
  else if (body)
    content.push({
      type: 'bulletList',
      content: body.map((b) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: b }] }] })),
    });
  const text = [title, ...(typeof body === 'string' ? [body] : (body ?? []))].join('\n');
  return { bodyJson: JSON.stringify({ type: 'doc', content }), bodyText: text };
}

// Altura aproximada de una nota para colocarlas sin que se pisen.
const heightOf = (it: Item) =>
  64 + (it.task ? 30 : 0) + (typeof it.body === 'string' ? 24 * Math.ceil(it.body.length / 28) : (it.body?.length ?? 0) * 26);

const args = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(process.env.CANVIAN_DB ?? resolve(here, '../data/canvian.db'));
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const EXAMPLE = sql`json_extract(${notes.props}, '$.ejemplo') = 1`;

if (args.includes('--borrar')) {
  const n = db.delete(notes).where(EXAMPLE).run().changes;
  console.log(`Borradas ${n} notas de ejemplo de ${dbPath}`);
  process.exit(0);
}

const all = db.select().from(profiles).all();
if (!all.length) {
  console.error('No hay perfiles todavía. Abre Canvian y crea tu contraseña primero.');
  process.exit(1);
}
const already = db.select({ n: sql<number>`count(*)` }).from(notes).where(EXAMPLE).get()?.n ?? 0;
if (already && !args.includes('--otra-vez')) {
  console.error(`Ya hay ${already} notas de ejemplo. Usa --borrar para quitarlas o --otra-vez para añadir más.`);
  process.exit(1);
}
const extraIdx = args.indexOf('--extra');
const extra = extraIdx >= 0 ? Number(args[extraIdx + 1]) || 0 : 0;

const random = rng(42);
const dueIn = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const DAY = 86_400_000;
const NOTE_W = 250;
const GAP = 36;
const COLS = 4;
const props = JSON.stringify({ ejemplo: true });

function seedProfile(profileId: string, zones: Zone[], loose: string[], extraCount: number) {
  const noteRows: (typeof notes.$inferInsert)[] = [];
  const edgeRows: (typeof edges.$inferInsert)[] = [];
  const zoneHubs: string[] = [];
  const allIds: string[] = [];
  const when = (maxDays: number) => new Date(Date.now() - random() ** 1.6 * maxDays * DAY).toISOString();
  const link = (a: string, b: string) => edgeRows.push({ id: ulid(), profileId, fromId: a, toId: b });

  let zx = 0;
  let zy = 0;
  let rowH = 0;
  zones.forEach((zone, zi) => {
    // Coloca las notas en columnas, cada una bajo la anterior.
    const colH = Array(COLS).fill(0);
    const placed = zone.items.map((it) => {
      const c = colH.indexOf(Math.min(...colH));
      const pos = { x: c * (NOTE_W + GAP), y: colH[c] };
      colH[c] += heightOf(it) + GAP;
      return pos;
    });
    const w = COLS * (NOTE_W + GAP) + 2 * 48 - GAP;
    const h = Math.max(...colH) + 96 + 48;
    if (zi > 0 && zi % 3 === 0) {
      zx = 0;
      zy += rowH + 160;
      rowH = 0;
    }
    const zoneId = ulid();
    const updated = when(20);
    noteRows.push({ id: zoneId, profileId, kind: 'zone', title: zone.name, x: zx, y: zy, w, h, props, createdAt: updated, updatedAt: updated });
    const ids = zone.items.map((it, i) => {
      const id = ulid();
      const updatedAt = when(60);
      const { bodyJson, bodyText } = doc(it.t, it.body);
      noteRows.push({
        id,
        profileId,
        kind: it.task ? 'task' : 'text',
        title: it.t,
        bodyJson,
        bodyText,
        x: zx + 48 + placed[i].x,
        y: zy + 96 + placed[i].y,
        w: NOTE_W,
        zoneId,
        status: it.task ?? null,
        doneAt: it.task === 'done' ? updatedAt : null,
        priority: it.task && random() < 0.6 ? 1 + Math.floor(random() * 3) : null,
        dueAt: it.task && random() < 0.5 ? dueIn(Math.round(random() * 24) - 5) : null,
        props,
        createdAt: updatedAt,
        updatedAt,
      });
      return id;
    });
    // La primera nota de cada zona es su centro: se enlaza con varias de las demás.
    const [hub, ...rest] = ids;
    zoneHubs.push(hub);
    rest.forEach((id, i) => {
      if (i % 2 === 0 || random() < 0.3) link(hub, id);
      else if (i > 0 && random() < 0.6) link(rest[i - 1], id);
    });
    allIds.push(...ids);
    zx += w + 160;
    rowH = Math.max(rowH, h);
  });

  // Algunas conexiones entre zonas para que haya constelaciones.
  for (let i = 0; i < zoneHubs.length; i++) link(zoneHubs[i], zoneHubs[(i + 1) % zoneHubs.length]);
  for (let i = 0; i < 6; i++) {
    const a = allIds[Math.floor(random() * allIds.length)];
    const b = allIds[Math.floor(random() * allIds.length)];
    if (a !== b) link(a, b);
  }

  // Notas sueltas y, si se piden, muchas más para probar el rendimiento.
  const top = zy + rowH + 200;
  const items = [
    ...loose.map((t) => ({ t })),
    ...Array.from({ length: extraCount }, (_, i) => ({
      t: `${WORDS[i % WORDS.length]} sobre ${TOPICS[Math.floor(random() * TOPICS.length)]} #${i + 1}`,
    })),
  ];
  items.forEach((it, i) => {
    const id = ulid();
    const updatedAt = when(90);
    const task = random() < 0.25 ? (['todo', 'doing', 'done'] as const)[Math.floor(random() * 3)] : null;
    noteRows.push({
      id,
      profileId,
      kind: task ? 'task' : 'text',
      title: it.t,
      ...doc(it.t),
      x: (i % 12) * (NOTE_W + GAP) + (random() - 0.5) * 40,
      y: top + Math.floor(i / 12) * 110 + (random() - 0.5) * 30,
      w: NOTE_W,
      status: task,
      doneAt: task === 'done' ? updatedAt : null,
      props,
      createdAt: updatedAt,
      updatedAt,
    });
    if (i > 0 && random() < 0.15) link(id, noteRows[noteRows.length - 2].id!);
  });

  db.transaction((tx) => {
    for (const r of noteRows) tx.insert(notes).values(r).run();
    for (const e of edgeRows) tx.insert(edges).values(e).run();
  });
  return { notes: noteRows.length, edges: edgeRows.length };
}

const personal = all.find((p) => /personal/i.test(p.name)) ?? all[0];
const trabajo = all.find((p) => /trabajo/i.test(p.name) && p.id !== personal.id);
const r1 = seedProfile(personal.id, PERSONAL, LOOSE, extra);
console.log(`${personal.name}: ${r1.notes} notas y ${r1.edges} enlaces`);
if (trabajo) {
  const r2 = seedProfile(trabajo.id, TRABAJO, LOOSE.slice(0, 4), extra);
  console.log(`${trabajo.name}: ${r2.notes} notas y ${r2.edges} enlaces`);
}
console.log(`Listo (${dbPath}). Recarga Canvian y pulsa 1 para verlo todo.`);
