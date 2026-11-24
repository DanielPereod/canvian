import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from 'ts-fsrs';
import type { Db } from '../db/index.js';
import { nbCards, nbMessages, nbReviews, nbSources, nbTopics, notebooks } from '../db/schema.js';

// Cuadernos: el modelo (sin la IA). Ver ../ai/claude.ts para quién enseña y
// ./tutor.ts para lo que se le pide.

export type Notebook = typeof notebooks.$inferSelect;
export type Topic = typeof nbTopics.$inferSelect;
export type Source = typeof nbSources.$inferSelect;
export type Message = typeof nbMessages.$inferSelect;
export type CardRow = typeof nbCards.$inferSelect;

export class NbError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const nowIso = () => new Date().toISOString();
export const list = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

// Los colores de las tapas, en orden.
export const COVERS = ['#3f5fae', '#2f7d4f', '#a8661b', '#8a4f9e', '#b2413b', '#2b7a8a'];

export function notebookOf(db: Db, id: string): Notebook {
  const nb = db.select().from(notebooks).where(eq(notebooks.id, id)).get();
  if (!nb) throw new NbError('Cuaderno no encontrado', 404);
  return nb;
}
export function topicOf(db: Db, id: string): Topic {
  const t = db.select().from(nbTopics).where(eq(nbTopics.id, id)).get();
  if (!t) throw new NbError('Tema no encontrado', 404);
  return t;
}
export const topicsOf = (db: Db, notebookId: string) =>
  db.select().from(nbTopics).where(eq(nbTopics.notebookId, notebookId)).orderBy(asc(nbTopics.position)).all();
export const messagesOf = (db: Db, topicId: string) =>
  db.select().from(nbMessages).where(eq(nbMessages.topicId, topicId)).orderBy(asc(nbMessages.position)).all();

export function createNotebook(db: Db, profileId: string, v: { title: string; goal?: string | null }) {
  const n = db.select({ n: sql<number>`count(*)` }).from(notebooks).where(eq(notebooks.profileId, profileId)).get()!.n;
  return db
    .insert(notebooks)
    .values({ id: ulid(), profileId, title: v.title, goal: v.goal ?? null, color: COVERS[n % COVERS.length], position: n })
    .returning()
    .get();
}

export function touch(db: Db, notebookId: string) {
  db.update(notebooks).set({ updatedAt: nowIso() }).where(eq(notebooks.id, notebookId)).run();
}

/** El temario: sustituye los temas sin empezar y deja los que ya tienen trabajo. */
export function setSyllabus(db: Db, notebookId: string, items: { title: string; summary?: string; dependsOn?: number[] }[]) {
  const before = topicsOf(db, notebookId);
  const busy = new Set(
    before
      .filter((t) => t.status !== 'pendiente' || t.noteId || db.select({ id: nbMessages.id }).from(nbMessages).where(eq(nbMessages.topicId, t.id)).get())
      .map((t) => t.id),
  );
  const fold = (s: string) => s.trim().toLocaleLowerCase();
  const keepByTitle = new Map(before.filter((t) => busy.has(t.id)).map((t) => [fold(t.title), t]));
  const drop = before.filter((t) => !busy.has(t.id)).map((t) => t.id);
  if (drop.length) db.delete(nbTopics).where(inArray(nbTopics.id, drop)).run();
  const ids = items.map((it) => keepByTitle.get(fold(it.title))?.id ?? ulid());
  items.forEach((it, i) => {
    const deps = (it.dependsOn ?? []).filter((d) => d >= 0 && d < i).map((d) => ids[d]);
    const kept = keepByTitle.get(fold(it.title));
    const values = { position: i, title: it.title.trim().slice(0, 200), summary: it.summary?.trim().slice(0, 600) || null, dependsOn: JSON.stringify(deps), updatedAt: nowIso() };
    if (kept) {
      db.update(nbTopics).set(values).where(eq(nbTopics.id, kept.id)).run();
      keepByTitle.delete(fold(it.title));
    } else db.insert(nbTopics).values({ id: ids[i], notebookId, ...values }).run();
  });
  // Los que tenían trabajo y ya no salen en el temario van al final.
  let pos = items.length;
  for (const t of keepByTitle.values()) db.update(nbTopics).set({ position: pos++ }).where(eq(nbTopics.id, t.id)).run();
  touch(db, notebookId);
  return topicsOf(db, notebookId);
}

export function addMessage(db: Db, topicId: string, role: 'tutor' | 'yo', body: string, stage: string | null) {
  const n = db.select({ n: sql<number>`count(*)` }).from(nbMessages).where(eq(nbMessages.topicId, topicId)).get()!.n;
  return db.insert(nbMessages).values({ id: ulid(), topicId, position: n, role, body, stage }).returning().get();
}

// ── Fuentes ───────────────────────────────────────────────────────────

/** Las fuentes que valen para un tema: las suyas y las del cuaderno entero. */
export function sourcesFor(db: Db, notebookId: string, topicId: string | null, withRemoved = false) {
  return db
    .select()
    .from(nbSources)
    .where(eq(nbSources.notebookId, notebookId))
    .orderBy(asc(nbSources.createdAt))
    .all()
    .filter((s) => (withRemoved || !s.removed) && (s.topicId === null || s.topicId === topicId));
}

const sameUrl = (a: string | null, b: string | null) => !!a && !!b && a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/** Añade fuentes; las que se quitaron antes (por su enlace o nota) no vuelven si las propone la IA. */
export function addSources(
  db: Db,
  notebookId: string,
  topicId: string | null,
  items: { kind?: string; title: string; url?: string | null; noteId?: string | null; why?: string | null }[],
  origin: 'ia' | 'manual',
) {
  const existing = db.select().from(nbSources).where(eq(nbSources.notebookId, notebookId)).all();
  const out: Source[] = [];
  for (const it of items) {
    const twin = existing.find((s) => (s.topicId === topicId || s.topicId === null) && ((it.url && sameUrl(s.url, it.url ?? null)) || (it.noteId && s.noteId === it.noteId)));
    if (twin) {
      // Quien la añade a mano la recupera aunque la hubiera quitado.
      if (twin.removed && origin === 'manual') {
        db.update(nbSources).set({ removed: 0, origin: 'manual' }).where(eq(nbSources.id, twin.id)).run();
        out.push({ ...twin, removed: 0, origin: 'manual' });
      }
      continue;
    }
    const kind = ['web', 'video', 'libro', 'pdf', 'nota'].includes(it.kind ?? '') ? it.kind! : it.noteId ? 'nota' : /youtu\.?be|vimeo/.test(it.url ?? '') ? 'video' : /\.pdf($|\?)/i.test(it.url ?? '') ? 'pdf' : 'web';
    const row = db
      .insert(nbSources)
      .values({ id: ulid(), notebookId, topicId, kind, title: it.title.trim().slice(0, 300), url: it.url ?? null, noteId: it.noteId ?? null, why: it.why?.slice(0, 300) ?? null, origin })
      .returning()
      .get();
    existing.push(row);
    out.push(row);
  }
  touch(db, notebookId);
  return out;
}

// ── Tarjetas y repaso (FSRS) ───────────────────────────────────────────

const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: true, enable_short_term: true });

const toCard = (r: CardRow): Card => ({
  due: new Date(r.due),
  stability: r.stability,
  difficulty: r.difficulty,
  elapsed_days: 0,
  scheduled_days: r.scheduledDays,
  learning_steps: r.learningSteps,
  reps: r.reps,
  lapses: r.lapses,
  state: r.state,
  last_review: r.lastReview ? new Date(r.lastReview) : undefined,
});
const fromCard = (c: Card) => ({
  due: c.due.toISOString(),
  stability: c.stability,
  difficulty: c.difficulty,
  scheduledDays: c.scheduled_days,
  learningSteps: c.learning_steps,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state,
  lastReview: c.last_review ? c.last_review.toISOString() : null,
});

export const CARD_KINDS = ['dato', 'explica', 'problema'] as const;

export function addCards(db: Db, notebookId: string, topicId: string | null, items: { kind?: string; front: string; back: string }[], now = new Date()) {
  const empty = fromCard(createEmptyCard(now));
  const rows = items
    .filter((c) => c.front.trim() && c.back.trim())
    .map((c) => ({
      id: ulid(),
      notebookId,
      topicId,
      kind: (CARD_KINDS as readonly string[]).includes(c.kind ?? '') ? c.kind! : 'dato',
      front: c.front.trim().slice(0, 2000),
      back: c.back.trim().slice(0, 4000),
      ...empty,
    }));
  if (rows.length) db.insert(nbCards).values(rows).run();
  touch(db, notebookId);
  return rows;
}

/** Cuándo volvería cada nota (1–4), para enseñarlo en los botones. */
export function preview(r: CardRow, now = new Date()) {
  const p = scheduler.repeat(toCard(r), now);
  return ([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as Grade[]).map((g) => p[g].card.due.toISOString());
}

export function grade(db: Db, cardId: string, rating: number, extra: { confidence?: number | null; answer?: string | null } = {}, now = new Date()) {
  const r = db.select().from(nbCards).where(eq(nbCards.id, cardId)).get();
  if (!r) throw new NbError('Tarjeta no encontrada', 404);
  if (![1, 2, 3, 4].includes(rating)) throw new NbError('Nota no válida');
  const next = scheduler.next(toCard(r), now, rating as Grade).card;
  const saved = db.update(nbCards).set(fromCard(next)).where(eq(nbCards.id, cardId)).returning().get()!;
  db.insert(nbReviews)
    .values({ id: ulid(), cardId, rating, confidence: extra.confidence ?? null, answer: extra.answer?.slice(0, 4000) ?? null, reviewedAt: now.toISOString() })
    .run();
  return saved;
}

/** Lo que toca repasar hoy, mezclando temas (intercalado) pero de forma estable. */
export function dueCards(db: Db, notebookIds: string[], now = new Date(), limit = 200) {
  if (!notebookIds.length) return [];
  const rows = db
    .select()
    .from(nbCards)
    .where(and(inArray(nbCards.notebookId, notebookIds), lte(nbCards.due, now.toISOString())))
    .orderBy(asc(nbCards.due))
    .limit(limit)
    .all();
  // Repartidas por tema: una de cada uno por turnos, para no repasar en bloque.
  const byTopic = new Map<string, CardRow[]>();
  for (const r of rows) {
    const k = r.topicId ?? '';
    byTopic.set(k, [...(byTopic.get(k) ?? []), r]);
  }
  const queues = [...byTopic.values()];
  const out: CardRow[] = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift()!);
  return out;
}

// ── Dominio y mapa ─────────────────────────────────────────────────────

export type Mastery = 'sin-tocar' | 'fallas' | 'fragil' | 'dominado';

/** Cómo va cada tema, sacado de sus tarjetas (no de lo leído). */
export function masteryOf(db: Db, notebookId: string, now = new Date()) {
  const cards = db.select().from(nbCards).where(eq(nbCards.notebookId, notebookId)).all();
  const byTopic = new Map<string, CardRow[]>();
  for (const c of cards) if (c.topicId) byTopic.set(c.topicId, [...(byTopic.get(c.topicId) ?? []), c]);
  const out: Record<string, { level: Mastery; cards: number; due: number; recall: number | null }> = {};
  for (const t of topicsOf(db, notebookId)) {
    const cs = byTopic.get(t.id) ?? [];
    const seen = cs.filter((c) => c.reps > 0);
    const due = cs.filter((c) => c.due <= now.toISOString()).length;
    if (!seen.length) {
      out[t.id] = { level: 'sin-tocar', cards: cs.length, due, recall: null };
      continue;
    }
    const recall = seen.reduce((s, c) => s + scheduler.get_retrievability(toCard(c), now, false), 0) / seen.length;
    const lapsing = seen.filter((c) => c.lapses > 0 && c.state === 3).length / seen.length;
    const settled = seen.length === cs.length && seen.every((c) => c.reps >= 2 && c.state === 2);
    const level: Mastery = lapsing > 0.3 || recall < 0.6 ? 'fallas' : settled && recall >= 0.85 ? 'dominado' : 'fragil';
    out[t.id] = { level, cards: cs.length, due, recall: Math.round(recall * 100) / 100 };
  }
  return out;
}

/** El siguiente tema que conviene: el primero sin hacer cuyos requisitos ya van bien. */
export function suggestNext(topics: Topic[], mastery: Record<string, { level: Mastery }>) {
  const ok = (id: string) => {
    const t = topics.find((x) => x.id === id);
    return !t || t.status === 'hecho' || mastery[id]?.level === 'dominado' || mastery[id]?.level === 'fragil';
  };
  const open = topics.filter((t) => t.status !== 'hecho');
  return open.find((t) => list(t.dependsOn).every(ok))?.id ?? open[0]?.id ?? null;
}

/** Calibración: con cada confianza dicha, cuántas veces se acertó (nota ≥ 3). */
export function calibration(db: Db, notebookId: string) {
  const rows = db
    .select({ confidence: nbReviews.confidence, rating: nbReviews.rating })
    .from(nbReviews)
    .innerJoin(nbCards, eq(nbCards.id, nbReviews.cardId))
    .where(and(eq(nbCards.notebookId, notebookId), sql`${nbReviews.confidence} is not null`))
    .all();
  return [25, 50, 75, 95].map((level) => {
    const hits = rows.filter((r) => r.confidence === level);
    return { confidence: level, answers: hits.length, right: hits.length ? Math.round((hits.filter((r) => r.rating >= 3).length / hits.length) * 100) : null };
  });
}
