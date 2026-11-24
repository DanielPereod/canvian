import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  real,
  integer,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// Clave/valor para ajustes de la instancia (hash de la contraseña, etc.).
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), // sha256 del token de la cookie
  createdAt: text('created_at').notNull().default(now),
  expiresAt: text('expires_at').notNull(),
});

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color'),
  icon: text('icon'),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
});

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // text | canvas | link | image | checklist | code (task, quick y zone son de antes: ver tasks.ts)
    title: text('title'),
    bodyJson: text('body_json'), // documento Tiptap
    bodyText: text('body_text'), // texto plano para la búsqueda
    props: text('props').notNull().default('{}'),
    x: real('x').notNull().default(0),
    y: real('y').notNull().default(0),
    w: real('w'),
    h: real('h'),
    z: integer('z').notNull().default(0),
    zoneId: text('zone_id'),
    status: text('status'), // de las notas-tarea de antes; las tareas son ahora casillas del texto
    priority: integer('priority'),
    dueAt: text('due_at'),
    doneAt: text('done_at'),
    archivedAt: text('archived_at'), // archivada: oculta salvo que se pidan las ocultas
    cover: text('cover'), // portada: imagen o degradado (ver web/src/canvas/cover.ts)
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    index('idx_notes_profile').on(t.profileId, t.deletedAt),
    index('idx_notes_tasks')
      .on(t.profileId, t.status, t.dueAt)
      .where(sql`${t.kind} = 'task'`),
  ],
);

export const propertyDefs = sqliteTable(
  'property_defs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(), // text | number | select | multi_select | date | checkbox | url
    options: text('options').notNull().default('[]'),
    appliesTo: text('applies_to').notNull().default('task'), // task | all
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('uq_property_defs_name').on(t.profileId, t.name)],
);

export const edges = sqliteTable(
  'edges',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    fromId: text('from_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    toId: text('to_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    label: text('label'),
    kind: text('kind').notNull().default('link'), // link | blocks
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('idx_edges_from').on(t.fromId), index('idx_edges_to').on(t.toId)],
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
  },
  (t) => [uniqueIndex('uq_tags_name').on(t.profileId, t.name)],
);

export const noteTags = sqliteTable(
  'note_tags',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.tagId] })],
);

export const lenses = sqliteTable('lenses', {
  id: text('id').primaryKey(),
  profileId: text('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  query: text('query').notNull(),
  mode: text('mode').notNull().default('dim'), // dim | hide | arrange
  slot: integer('slot'),
});

export const viewports = sqliteTable('viewports', {
  profileId: text('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  x: real('x').notNull().default(0),
  y: real('y').notNull().default(0),
  zoom: real('zoom').notNull().default(1),
});

// Notas públicas: un enlace (su id) que deja leer una nota sin entrar, con
// contraseña si se quiere. Si la nota tiene hijas, `scope` dice cuáles se ven:
// ninguna (note), todas (all, también las que se creen después) o las de
// `childIds` (some).
export const shares = sqliteTable('shares', {
  id: text('id').primaryKey(),
  noteId: text('note_id')
    .notNull()
    .unique()
    .references(() => notes.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash'),
  scope: text('scope').notNull().default('note'), // note | all | some
  childIds: text('child_ids').notNull().default('[]'),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

// Bases de datos: tablas propias, aparte de las notas (ver routes/databases.ts).
export const dbTables = sqliteTable(
  'db_tables',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon'),
    // La carpeta en la que se ve (solo para ordenar; no cambia las consultas).
    folder: text('folder'),
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [index('idx_db_tables_profile').on(t.profileId)],
);

// type: text | number | select | tags | date | checkbox | url | image | note | relation.
// options (JSON): { choices?: string[], target?: tableId, pair?: columnId, owner?: boolean, primary?: boolean }.
export const dbColumns = sqliteTable(
  'db_columns',
  {
    id: text('id').primaryKey(),
    tableId: text('table_id')
      .notNull()
      .references(() => dbTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    options: text('options').notNull().default('{}'),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('idx_db_columns_table').on(t.tableId)],
);

export const dbRows = sqliteTable(
  'db_rows',
  {
    id: text('id').primaryKey(),
    tableId: text('table_id')
      .notNull()
      .references(() => dbTables.id, { onDelete: 'cascade' }),
    data: text('data').notNull().default('{}'),
    position: real('position').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [index('idx_db_rows_table').on(t.tableId, t.position)],
);

// Cada enlace de una relación se guarda una vez, con la columna «dueña»; la
// columna pareja de la otra tabla lo lee al revés (de to_id a from_id).
export const dbLinks = sqliteTable(
  'db_links',
  {
    columnId: text('column_id')
      .notNull()
      .references(() => dbColumns.id, { onDelete: 'cascade' }),
    fromId: text('from_id')
      .notNull()
      .references(() => dbRows.id, { onDelete: 'cascade' }),
    toId: text('to_id')
      .notNull()
      .references(() => dbRows.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.columnId, t.fromId, t.toId] }), index('idx_db_links_to').on(t.columnId, t.toId)],
);

// Tareas vinculadas a un hilo de correo (la extensión del navegador, en
// Outlook). La tarea es una casilla de `noteId` con el id de bloque `blockId`
// («- [ ] … ^abc123»), así que se sigue encontrando aunque cambie la nota.
// El hilo se reconoce por `thread` (el id de la conversación que da Outlook)
// o, si cambia, por su asunto sin «RE:»/«RV:» (`subjectKey`).
export const mailLinks = sqliteTable(
  'mail_links',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    thread: text('thread').notNull(),
    subject: text('subject'),
    subjectKey: text('subject_key'),
    url: text('url'),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    blockId: text('block_id').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('uq_mail_links').on(t.profileId, t.thread, t.noteId, t.blockId),
    index('idx_mail_links_subject').on(t.profileId, t.subjectKey),
    index('idx_mail_links_task').on(t.noteId, t.blockId),
  ],
);

// ── Cuadernos (ver notebooks/) ──────────────────────────────────────────
// La IA enseña un tema desde cero: el cuaderno es la materia, los temas sus
// capítulos. status: diagnostico | activo. source_mode: auto | manual.
// diagnosis (JSON): [{ q, a }]. folder_id: la nota de la biblioteca donde se
// sugiere guardar las notas que escribe la persona.
export const notebooks = sqliteTable(
  'notebooks',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    goal: text('goal'),
    level: text('level'),
    color: text('color'),
    status: text('status').notNull().default('diagnostico'),
    diagnosis: text('diagnosis').notNull().default('[]'),
    sourceMode: text('source_mode').notNull().default('auto'),
    folderId: text('folder_id').references(() => notes.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [index('idx_notebooks_profile').on(t.profileId, t.position)],
);

// status: pendiente | estudiando | hecho. stage: la etapa de la sesión en la
// que va (entrada, idea, ejemplo, comprueba, intenta, socratico, nota, fin).
// gaps / solid (JSON): huecos que quedan y lo que ya está claro. lesson: la
// página limpia (Markdown) que queda para releer. note_id: la nota de la persona.
export const nbTopics = sqliteTable(
  'nb_topics',
  {
    id: text('id').primaryKey(),
    notebookId: text('notebook_id')
      .notNull()
      .references(() => notebooks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    title: text('title').notNull(),
    summary: text('summary'),
    dependsOn: text('depends_on').notNull().default('[]'),
    status: text('status').notNull().default('pendiente'),
    stage: text('stage'),
    gaps: text('gaps').notNull().default('[]'),
    solid: text('solid').notNull().default('[]'),
    lesson: text('lesson'),
    // Apuntes sacados de las fuentes (con de dónde sale cada cosa), para que el tutor se apoye en ellas.
    brief: text('brief'),
    noteId: text('note_id').references(() => notes.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [index('idx_nb_topics_notebook').on(t.notebookId, t.position), index('idx_nb_topics_note').on(t.noteId)],
);

// Fuentes de un tema (o de todo el cuaderno, sin topic_id). kind: web | video |
// libro | pdf | nota. origin: ia | manual. Una fuente quitada se queda con
// removed = 1 para que la IA no vuelva a proponerla.
export const nbSources = sqliteTable(
  'nb_sources',
  {
    id: text('id').primaryKey(),
    notebookId: text('notebook_id')
      .notNull()
      .references(() => notebooks.id, { onDelete: 'cascade' }),
    topicId: text('topic_id').references(() => nbTopics.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('web'),
    title: text('title').notNull(),
    url: text('url'),
    noteId: text('note_id').references(() => notes.id, { onDelete: 'cascade' }),
    why: text('why'),
    origin: text('origin').notNull().default('manual'),
    pinned: integer('pinned').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('idx_nb_sources_notebook').on(t.notebookId, t.topicId)],
);

// La conversación con el tutor en un tema. role: tutor | yo.
export const nbMessages = sqliteTable(
  'nb_messages',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => nbTopics.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    role: text('role').notNull(),
    stage: text('stage'),
    body: text('body').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('idx_nb_messages_topic').on(t.topicId, t.position)],
);

// Tarjetas de repaso con su estado FSRS (ts-fsrs). kind: dato | explica | problema.
export const nbCards = sqliteTable(
  'nb_cards',
  {
    id: text('id').primaryKey(),
    notebookId: text('notebook_id')
      .notNull()
      .references(() => notebooks.id, { onDelete: 'cascade' }),
    topicId: text('topic_id').references(() => nbTopics.id, { onDelete: 'set null' }),
    kind: text('kind').notNull().default('dato'),
    front: text('front').notNull(),
    back: text('back').notNull(),
    due: text('due').notNull(),
    stability: real('stability').notNull().default(0),
    difficulty: real('difficulty').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    state: integer('state').notNull().default(0),
    lastReview: text('last_review'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('idx_nb_cards_due').on(t.notebookId, t.due)],
);

// Cada repaso: la nota (1 otra vez · 2 difícil · 3 bien · 4 fácil), la
// confianza que se dijo antes de ver la respuesta (25–95) y lo que se escribió.
export const nbReviews = sqliteTable(
  'nb_reviews',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => nbCards.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    confidence: integer('confidence'),
    answer: text('answer'),
    reviewedAt: text('reviewed_at').notNull().default(now),
  },
  (t) => [index('idx_nb_reviews_card').on(t.cardId, t.reviewedAt)],
);
