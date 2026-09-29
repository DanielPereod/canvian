# Sistema de diseño de Canvian

Dirección: **una biblioteca de investigación**. Una barra lateral con tus notas en árbol, la colección en lista, portadas o nodos, y un lector tranquilo. El color del perfil es el acento. Cada tema cambia el aspecto (colores, letras, radios), nunca la estructura.

La muestra viva está en la propia app: abre `http://localhost:5173/#sistema`.

## Archivos

| Archivo | Qué contiene |
|---|---|
| `web/src/design/tokens.css` | Todos los tokens: primitivos, semánticos y movimiento |
| `web/src/design/base.css` | Reset, tipografía base, fondo nocturno |
| `web/src/design/components.css` | Superficies, botón, campo, tecla, píldora, popover, lista, toast |
| `web/src/canvas/canvas.css` | Texto de las notas (prosa) |
| `web/src/canvas/sections.css` | Vista de nodos, hoja de canvas, tareas y ordenar |
| `web/src/canvas/biblioteca.css` | La biblioteca: barra lateral, cabecera, colección, lector y los temas Biblioteca |
| `web/src/canvas/pieces.css` | Linterna, estado de tarea e interruptor |
| `web/src/app.css` | Cromo de la pantalla y luciérnagas |

## Reglas

- **Los componentes solo usan tokens semánticos** (`--text`, `--surface-2`, `--accent`…), nunca primitivos (`--n-800`) ni valores sueltos.
- **El acento es del perfil.** Se fija en `:root` desde `Workspace` y está registrado con `@property`, así que al cambiar de perfil la luz se funde. Los tokens derivados (`--accent-soft`, `--accent-glow`, `--pool`) se recalculan solos.
- **Tres superficies.** `surface-1` para notas (sin blur, hay cientos), `surface-2` para el cromo flotante, `surface-3` para popovers y diálogos (glass denso con un filo de luz arriba).
- **Tres voces tipográficas por tema.** Una letra funcional (`--font-ui`), una para los títulos grandes (`--title-font`, con su peso, estilo y mayúsculas) y una para leer (`--read-font`). En Jardín nocturno: Instrument Sans, Instrument Serif en cursiva y Instrument Sans; en Biblioteca: Jost, Jost y Newsreader.
- **Movimiento.** Entradas con `--ease-spring`, salidas rápidas con `--ease-in`, desvanecidos con `--ease-out`. Una nota se abre fundiéndose en el lector. Todo respeta `prefers-reduced-motion`.
- **Temas** (`web/src/design/themes.css` y los Biblioteca en `biblioteca.css`): un modo (claro, oscuro o automático) y un tema por tono. Además de los tokens de siempre, cada tema fija los de la biblioteca: `--bib-side` (barra lateral), `--bib-sel` (lo elegido), `--bib-cover-l`/`--bib-cover-c` (luz y color de las tapas), `--title-*` y `--read-*`. Sin ellos se usan los de fábrica de `biblioteca.css`.
- **Fondos por perfil** (`B`): liso, estrellas, luciérnagas y aurora (`web/src/backgrounds/`).

## La biblioteca

Canvian es una biblioteca (`web/src/canvas/Biblioteca.tsx`). A la izquierda, la barra lateral con el perfil, las vistas (todas las notas, tareas, ordenar, archivadas) y el árbol de notas; se pliega con `Ctrl .` y sale flotando al acercar el ratón al borde. Arriba, la ruta y el buscador. En el centro, la colección en la que estás, en lista, en portadas o en nodos (`NodeView.tsx`). La jerarquía está en los datos: `zoneId` es la nota madre de cada nota, y una nota con hijas es una colección en la que se entra. Una nota se abre en el lector (`NoteSheet`), con el texto a la izquierda y un panel de detalles a la derecha; un canvas se abre en su hoja a pantalla completa. La linterna atenúa u oculta lo que no encaja.
