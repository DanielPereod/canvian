# Canvian

Canvas infinito de notas enlazadas, con sus tareas dentro, con perfiles (Personal, Trabajo…) y filtros por teclado. Self-hosted: un contenedor y un archivo SQLite.

Estado: **fase 1**. Login, perfiles, y notas con texto enriquecido en el canvas: se crean, enlazan, anidan (cualquier nota puede tener hijas) y se buscan con ⌘P.

## Instalar en CasaOS

1. En CasaOS abre **App Store → Custom Install → Import** y pega el contenido de [`docker-compose.yml`](docker-compose.yml).
2. Instala. Los datos quedan en `/DATA/AppData/canvian/canvian.db`.
3. Abre `http://<ip-del-servidor>:3210` y elige tu contraseña. Se crean los perfiles Personal y Trabajo.

La imagen `ghcr.io/danielpereod/canvian` se publica sola al hacer merge en `main` (amd64 y arm64). Si el repositorio es privado, el paquete en GHCR también lo será: hazlo público en *GitHub → Packages → canvian → Package settings*, o haz `docker login ghcr.io` en el servidor.

Para actualizar: en CasaOS, botón de actualizar la app (vuelve a descargar `latest`).

Copia de seguridad: basta con copiar `canvian.db` (y los archivos `-wal`/`-shm` si existen) con la app parada.

## Desarrollo

```sh
npm install
npm run dev      # API en :3210 y web en :5173 (con proxy a la API)
npm test         # tests de la API
npm run build    # compila web y servidor
npm start        # sirve todo desde :3210
```

| Carpeta   | Qué hay |
|-----------|---------|
| `server/` | Hono + better-sqlite3 + Drizzle. Esquema en `src/db/schema.ts`, migraciones en `drizzle/` (se generan con `npm run db:generate -w server`) y se aplican al arrancar. |
| `web/`    | React 19 + Vite. La interfaz es una biblioteca (`web/src/canvas/Biblioteca.tsx`): barra lateral con el árbol de notas, la colección en lista, portadas o nodos, y un lector con su panel de detalles. |

Variables: `PORT` (3210), `CANVIAN_DB` (`./data/canvian.db`), `CANVIAN_MEDIA` (los archivos adjuntos a las notas: imágenes, vídeo, audio, PDF, documentos…; por defecto `media/` junto a la base, así que en Docker también quedan en el volumen `/data`), `CANVIAN_WEB_DIR` (por defecto `web/dist`), `CANVIAN_MCP_TOKEN` (llave fija para el MCP, en vez de crearla en Configuración › Asistentes IA) y `TZ` (la zona horaria: decide qué es «hoy» para las tareas que pide Claude).

## Datos de ejemplo

`npm run seed -w server` llena Personal y Trabajo con notas anidadas, tareas (casillas con subtareas) y enlaces de ejemplo (añade `-- --extra 400` para cientos de notas más). `npm run seed -w server -- --borrar` quita solo lo que creó.

## Temas

**Configuración** (`Ctrl ,`) está ordenada como Obsidian: secciones a la izquierda (General, Aspecto y Atajos de teclado) y sus ajustes a la derecha. En **Aspecto** se elige el modo (claro, oscuro o automático, que sigue al sistema) y un tema para cada tono: oscuros Jardín nocturno, Observatorio, Plano, Mínimo y Biblioteca; claros Papel, Bloques, Piedras de río, Mínimo claro y Biblioteca. Todos visten la misma biblioteca, cada uno con sus colores, su letra para los títulos y su letra para leer. El modo también se cambia con `Ctrl Mayús L` o desde la paleta de comandos (`Ctrl Mayús P`, «Modo claro/oscuro/automático»). Todo se guarda en el servidor, así que vale en todos tus dispositivos.

## Tareas

Las tareas no son notas aparte: son las casillas que escribes dentro de cualquier nota, como en Obsidian. Una casilla sangrada bajo otra (`Tab`) es su subtarea.

```md
- [ ] Pintar el salón #obra 📅 2026-10-05 ⏫
  - [x] Comprar pintura ✅ 2026-09-20
  - [/] Mover los muebles
    - [ ] El sofá
- [!] Llamar al fontanero
```

`[ ]` pendiente, `[/]` en curso, `[!]` bloqueada y `[x]` hecha. Lo demás va en la propia línea: `📅 AAAA-MM-DD` es la fecha, `⏫` `🔼` `🔽` la prioridad (alta, media, baja), `#palabra` una etiqueta y `✅ AAAA-MM-DD` cuándo se hizo. No hace falta escribirlo a mano: la vista de tareas (`A`) lo pone al cambiar la fecha, la prioridad o el estado, y lo escribe en la nota.

Al actualizar desde una versión en la que las tareas eran notas, el servidor las pasa solo, una vez, a casillas dentro de su nota madre (con su estado, fecha, prioridad y etiquetas). Una tarea que tenía más texto, notas dentro o enlaces se queda como nota y su casilla la enlaza (`- [ ] [[Título]]`); las tareas rápidas y las que no estaban dentro de ninguna nota van a una nota «Tareas».

## Conectar con Claude (MCP)

Canvian lleva un servidor MCP en `/mcp` para que Claude lea y escriba tus notas: buscar y leer notas, crearlas y editarlas en Markdown (con `[[enlaces]]`), listar, añadir y completar tareas, mover, archivar y poner propiedades, y un resumen de la actividad reciente. Respeta los perfiles.

En Configuración › Asistentes IA, pulsa «Crear enlace», pon tu dirección pública (los asistentes en la nube tienen que llegar al servidor por internet con https) y copia la configuración del cliente que uses: Claude (claude.ai y Claude Code), ChatGPT, Codex, OpenCode, Gemini CLI, Cursor, VS Code u otro.

La llave también vale como cabecera `Authorization: Bearer <llave>` en `/mcp`. Crear otra invalida la anterior.

## Archivos adjuntos

Cualquier archivo puede ir dentro de una nota: se pega, se suelta en el texto o se elige con **Adjuntar** en el panel de detalles, y entra donde está el cursor. Imágenes, vídeo y audio se ven en la propia nota; lo demás (PDF, Word, Excel, ZIP…) queda como una ficha con su nombre y tamaño: un clic abre el PDF en otra pestaña o descarga el resto con su nombre. Hasta 200 MB por archivo. Por seguridad, lo que podría ejecutar código en el navegador (HTML, SVG…) solo se descarga, nunca se abre.

## Atajos

Todos los comandos viven en un solo registro (`web/src/keys.ts`), agrupados en Ir a, Crear, Lo señalado, Nota, Tareas, Ordenar, Ver y Aplicación. Hay tres capas: `⌘/Ctrl P` para ir a una nota, `⌘/Ctrl ⇧ P` para hacer cualquier cosa (la paleta enseña solo lo que sirve donde estás, con los recientes arriba, e incluye lo que no tiene tecla) y unas pocas letras que significan lo mismo en todas las listas. `?` abre la lista de atajos, con lo de la vista actual primero (`Ctrl H` también, si no la usas para otra cosa). En **Configuración › Atajos de teclado** (`Ctrl ,`) se cambian o se quitan; se guardan en el servidor. Estos son los de fábrica:

| Atajo | Acción |
|-------|--------|
| Barra lateral | El árbol de notas, como el explorador de archivos de Obsidian: las notas madre hacen de carpetas (su contenido son sus hijas) y cualquier nota puede estar arriba del todo o dentro de otra. Primero las madres y luego las demás, por orden alfabético (o como las dejes arrastrando). Clic en una nota la abre; en una madre, además la despliega (otro clic la pliega). Arrastrar una nota sobre otra la mete dentro, entre dos la coloca ahí, y al hueco del árbol o a «Mi biblioteca» la saca arriba del todo. Junto a «Mi biblioteca», `＋` crea una nota arriba del todo y el otro botón pliega todo |
| Vista de nodos | Un grafo como el de Obsidian: todas las notas como puntos que se colocan solos, unidos por sus enlaces y por la línea madre → hija; el tamaño dice cuántas relaciones tiene. Al pasar por encima se encienden la nota y sus vecinas; los nombres aparecen al acercarse. Arrastra los puntos o el fondo, rueda (o dos dedos) para acercar, clic abre la nota. `+`/`-` acercan, `0` encuadra todo, `Esc` suelta la nota del centro. El botón de ajustes permite ver solo lo que rodea a la nota (con profundidad), quitar las líneas madre → hija o las notas sin relaciones y poner flechas en los enlaces |
| `⌘/Ctrl G` | Modo nodo: la vista de nodos se centra en la nota abierta y la resalta (también con el botón «Nodos»); sin nota abierta, abre la del centro |
| `⌘/Ctrl ⇧ B` | Plegar la barra lateral (sale flotando al acercar el ratón al borde) o fijarla |
| Clic en una nota con hijas (o `Enter`) | Entrar en ella: la colección muestra lo que tiene dentro |
| Clic en una nota sin hijas (o `Enter`) | Abrirla en el lector, con su panel de detalles a la derecha |
| `Esc` / `Retroceso` | Salir: cierra el lector o sube un nivel |
| Clic en una miga de pan | Volver a ese nivel |
| `1` | Volver a todas las notas |
| `N` | Nota nueva en la nota con hijas señalada o en la que estás |
| `⌘/Ctrl N` | Nota rápida desde cualquier sitio (en Tareas, apunta una tarea). En una pestaña normal el navegador se queda `Ctrl N` para abrir otra ventana, así que también vale `⌘/Ctrl Alt N`; a pantalla completa (modo zen a pantalla completa) Chrome deja usar `Ctrl N` |
| `⌘/Ctrl ⇧ D` | La nota de hoy: abre la titulada con la fecha (AAAA-MM-DD) o la crea arriba del todo |
| `⌘/Ctrl O` | Cambiar de nota (igual que `⌘/Ctrl P`, como el selector de Obsidian) |
| «Canvas nuevo» (paleta) | Canvas nuevo: una nota que es un lienzo libre, como los de Obsidian. Doble clic en el vacío crea una tarjeta; desde los bordes de una tarjeta se tiran flechas a otra; abajo se añaden tarjetas, notas existentes (doble clic las abre), grupos y archivos de cualquier tipo (también pegando o soltando; un PDF o un documento se abre con doble clic). `Supr` borra lo seleccionado. Se guarda en formato JSON Canvas |
| `⇧N` | Nota nueva dentro de la señalada (así se anidan) |
| `R` | Renombrar la nota señalada (cambia su primera línea) |
| `M` | Mover a…: meter la nota señalada o abierta (o la tarea, o las marcadas en Ordenar) dentro de otra |
| `⌘/Ctrl Mayús X` | Archivar o desarchivar la nota abierta o señalada: se oculta con todo lo que cuelga de ella (también con el botón «Archivar») |
| «Archivadas» (barra o paleta) | Mostrar u ocultar las notas archivadas |
| `P` | Propiedades de la nota señalada: tipo (nota o canvas), prioridad, fecha y propiedades propias del perfil (texto, opciones, número, fecha, casilla, enlace) |
| `Supr` | Borrar la nota señalada (sus hijas pasan a su madre) |
| En el lector | Escribir; en el panel de la derecha, sus datos (también cuántas de sus tareas están hechas), sus enlaces (`＋ Enlazar` busca otra nota, `×` quita el enlace) y archivar, propiedades o borrar |
| `⌘/Ctrl ⇧ F` (en una nota) | Modo zen: se quita toda la interfaz (barra lateral, ruta y detalles) y solo queda el texto para escribir; sigue al pasar de una nota a otra. `Esc` o el mismo atajo vuelven (también con el botón «Zen») |
| «Texto ancho» (menú ⋯ o paleta) | Modo ancho: el texto de la nota se muestra más ancho; cada nota recuerda el suyo (también con el botón «Ancho») |
| `[[` (escribiendo en una nota) | Abre el buscador de notas para enlazar, como en Obsidian: `↑`/`↓` eligen, `Enter` o `Tab` ponen el `[[enlace]]` (y unen las dos notas), `Esc` lo cierra. Si no existe, «Crear nota» la crea al lado. Vale `[[Nota#Sección\|alias]]`, y escribir `[[Nota]]` entero también enlaza. Clic en el enlace abre la nota |
| Markdown al escribir | El de Obsidian: `#`…`######`, `**negrita**`, `*cursiva*`, `~~tachado~~`, `==resaltado==` (también `⌘/Ctrl ⇧ H`), `` `código` ``, `[texto](url)`, `- `, `1. `, `- [ ] ` (casillas: tareas; `[/]` en curso, `[!]` bloqueada, y con `Tab` subtareas), `> `, ` ``` ` y `---` |
| `A` | Vista de tareas: todas las casillas de todas las notas del perfil, agrupadas por fecha, estado o nota (`Tab` cambia), con sus subtareas debajo. `↑`/`↓` para moverse, `Enter` abre su nota con la tarea señalada, `Espacio` la marca hecha (y sus subtareas), `X` avanza el estado, `⇧X` la bloquea, `E` edita el texto, `M` la lleva a otra nota, `V` cambia entre lista y tablero, `Supr` la borra (con sus subtareas), `N` apunta una tarea (va a la nota «Tareas», o a otra con `> nota`), `Esc` vuelve. Al pie se ven las teclas de la vista. En el detalle se ponen fecha, prioridad, etiquetas y subtareas |
| `O` | Ordenar: el árbol de notas con hijas a un lado y lo que hay dentro de la elegida al otro (también desde Configuración). Clic o `Espacio` marca, `⇧` marca seguidas; se mueven arrastrándolas a otra nota, con `M` o aceptando el sitio sugerido (`S`). `←`/`→` cambia de rama, `/` busca en todas, `⌘/Ctrl Z` deshace, `⇧N` crea una nota, `Esc` vuelve |
| `F` | Linterna: filtra la colección o los nodos en vivo. Palabras sueltas (`-palabra` para excluir, `"frase exacta"`), `tipo:tarea` (notas con tareas pendientes; o `nota`, `canvas`), `estado:pendiente\|curso\|bloqueada\|hecha` (notas con alguna tarea así), `prio:alta`, `vence:hoy\|semana\|vencida\|<7d` (la fecha de la nota o de sus tareas), `en:viaje` (dentro de una nota), `#etiqueta`, `enlazado:"Plan de viaje" prof:2` y `<propiedad>:<valor>`. `Enter` la pliega, `Esc` la apaga |
| `Tab` (con la linterna) | Cambia el modo: atenuar (lo demás se apaga) u ocultar |
| `⌘/Ctrl S` (en la linterna) | Guarda la lente; se abre luego desde la lista al abrir `F` vacía |
| Arrastrar archivos `.md` | Importarlos como notas dentro de la nota en la que estás; los `[[enlaces]]` entre ellas se convierten en enlaces, y las tablas en tablas de verdad |
| Pegar o arrastrar imágenes, vídeo o audio | Dentro de una nota abierta, se añaden donde está el cursor o donde los sueltas. Sobre la biblioteca, crean una nota nueva con ellos. Hasta 200 MB por archivo |
| «Exportar a JSON Canvas» (paleta) | Exportar el perfil a JSON Canvas (`.canvas`, se abre en Obsidian) |
| `⌘/Ctrl P` | El buscador: buscar notas y abrirlas, o crear una. `Padre>Hija>Nota` busca dentro de esa ruta y crea ahí lo que falte; `Tab` completa con la señalada. `#etiqueta` en el texto pone esa etiqueta a la nota nueva (también en las tareas rápidas) |
| `⌘/Ctrl ⇧ P` | Paleta de comandos: lo que sirve donde estás (también temas, modo y secciones de Configuración), se ejecuta al elegirlo. En el móvil, «Comandos» en el cajón |
| «Cambiar de perfil» (barra o paleta) | Cambiar de perfil, crear uno o cerrar sesión |
