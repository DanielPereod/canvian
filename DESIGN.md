# Sistema de diseño de Canvian

Dirección: **jardín nocturno**. Negro profundo con retícula de puntos, notas como piezas oscuras que florecen al aparecer, enlaces orgánicos como tallos y luz del color del perfil que sube desde el suelo. Nada de interfaz corporativa: poca UI, mucho movimiento cuidado.

La muestra viva está en la propia app: abre `http://localhost:5173/#sistema`.

## Archivos

| Archivo | Qué contiene |
|---|---|
| `web/src/design/tokens.css` | Todos los tokens: primitivos, semánticos y movimiento |
| `web/src/design/base.css` | Reset, tipografía base, fondo nocturno |
| `web/src/design/components.css` | Superficies, botón, campo, tecla, píldora, popover, lista, toast |
| `web/src/canvas/canvas.css` | Notas, zonas, tallos, asas |
| `web/src/app.css` | Cromo de la pantalla y luciérnagas |

## Reglas

- **Los componentes solo usan tokens semánticos** (`--text`, `--surface-2`, `--accent`…), nunca primitivos (`--n-800`) ni valores sueltos.
- **El acento es del perfil.** Se fija en `:root` desde `Workspace` y está registrado con `@property`, así que al cambiar de perfil la luz se funde. Los tokens derivados (`--accent-soft`, `--accent-glow`, `--pool`) se recalculan solos.
- **Tres superficies.** `surface-1` para notas (sin blur, hay cientos), `surface-2` para el cromo flotante, `surface-3` para popovers y diálogos (glass denso con un filo de luz arriba).
- **Tres voces tipográficas.** Instrument Sans para todo lo funcional; Instrument Serif (a menudo itálica) para títulos de notas y zonas y para una palabra de acento en los titulares (`<h1 class="display">Hola de <em>nuevo</em></h1>`); Silkscreen solo para la marca y metadatos diminutos (`.meta`).
- **Movimiento.** Entradas con `--ease-spring`, salidas rápidas con `--ease-in`, desvanecidos con `--ease-out`. Las notas florecen (escala + desenfoque + opacidad), los tallos crecen al crearse y llevan un pulso de luz al señalarlos. Todo respeta `prefers-reduced-motion`.
- **Tema oscuro único**, a propósito.
