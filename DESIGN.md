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
| `web/src/canvas/sections.css` | Mapa de secciones, hoja de nota, arrastre |
| `web/src/app.css` | Cromo de la pantalla y luciérnagas |

## Reglas

- **Los componentes solo usan tokens semánticos** (`--text`, `--surface-2`, `--accent`…), nunca primitivos (`--n-800`) ni valores sueltos.
- **El acento es del perfil.** Se fija en `:root` desde `Workspace` y está registrado con `@property`, así que al cambiar de perfil la luz se funde. Los tokens derivados (`--accent-soft`, `--accent-glow`, `--pool`) se recalculan solos.
- **Tres superficies.** `surface-1` para notas (sin blur, hay cientos), `surface-2` para el cromo flotante, `surface-3` para popovers y diálogos (glass denso con un filo de luz arriba).
- **Tres voces tipográficas.** Instrument Sans para todo lo funcional; Instrument Serif (a menudo itálica) para títulos de notas y zonas y para una palabra de acento en los titulares (`<h1 class="display">Hola de <em>nuevo</em></h1>`); Silkscreen solo para la marca y metadatos diminutos (`.meta`).
- **Movimiento.** Entradas con `--ease-spring`, salidas rápidas con `--ease-in`, desvanecidos con `--ease-out`. En el mapa todo va despacio: las celdas respiran, los bordes ondulan poco y una nota se abre creciendo desde su celda. Todo respeta `prefers-reduced-motion`.
- **Fondos por perfil** (`B`): liso, estrellas (derivan despacio), luciérnagas y aurora; son capas ambientales detrás del mapa (`web/src/backgrounds/`).
- **Tema oscuro único**, a propósito.

## El mapa de secciones

Canvian es un solo mapa vivo (`web/src/canvas/SectionMap.tsx` + `fluid.ts`). Cada nivel es un diagrama de potencia que se recalcula en cada fotograma: las celdas ocupan área según su importancia (enlaces, prioridad, en curso, vencida, reciente) y los bordes fluyen despacio. La jerarquía está en los datos: `zoneId` es la sección madre de cada nota o sección; muchas notas en una misma sección se agrupan por cercanía. La rueda acerca y aleja sin saltos; clic entra en una sección o, en una nota, sigue acercándose hasta que la celda se convierte en una hoja a pantalla completa (`NoteSheet`). Arrastrar una celda sobre una sección (o sobre una miga de pan) la mueve allí. La linterna atenúa las celdas que no encajan u, ocultando, las encoge para que las demás ocupen su sitio.

## Experimentos

Ideas en prueba, cada una detrás de una clase `exp-*` en `.workspace` que se
enciende desde el laboratorio (`E`, `web/src/lab/`). Se guardan en el navegador.

- **Luz como memoria** (`memoria`): las celdas que no tocas en un mes se van apagando.
- **Tareas que maduran** (`maduran`): semilla, brote y flor en lugar del círculo que se llena.
