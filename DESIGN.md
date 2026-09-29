# Sistema de diseño de Canvian

Dirección: **jardín nocturno**. Negro profundo, un mapa de secciones orgánicas que respiran despacio y se reparten el espacio como un fluido, y luz del color del perfil. Nada de interfaz corporativa: poca UI, movimiento cuidado y en calma.

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
- **Tres voces tipográficas.** Instrument Sans para todo lo funcional; Instrument Serif (a menudo itálica) para títulos de notas y zonas y para una palabra de acento en los titulares (`<h1 class="display">Hola de <em>nuevo</em></h1>`); Silkscreen solo para la marca y metadatos diminutos (`.meta`).
- **Movimiento.** Entradas con `--ease-spring`, salidas rápidas con `--ease-in`, desvanecidos con `--ease-out`. Una nota se abre fundiéndose en el lector. Todo respeta `prefers-reduced-motion`.
- **Fondos por perfil** (`B`): liso, estrellas (derivan despacio), luciérnagas y aurora; son capas ambientales detrás del mapa (`web/src/backgrounds/`).
- **Tema oscuro único**, a propósito.

## La biblioteca

Canvian es una biblioteca (`web/src/canvas/Biblioteca.tsx`). A la izquierda, la barra lateral con el perfil, las vistas (todas las notas, tareas, ordenar, archivadas) y el árbol de notas; se pliega con `Ctrl .` y sale flotando al acercar el ratón al borde. Arriba, la ruta y el buscador. En el centro, la colección en la que estás, en lista, en portadas o en nodos (`NodeView.tsx`). La jerarquía está en los datos: `zoneId` es la nota madre de cada nota, y una nota con hijas es una colección en la que se entra. Una nota se abre en el lector (`NoteSheet`), con el texto a la izquierda y un panel de detalles a la derecha; un canvas se abre en su hoja a pantalla completa. La linterna atenúa u oculta lo que no encaja.
