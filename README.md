# Canvian

Canvas infinito de notas y tareas enlazadas, con perfiles (Personal, Trabajo…) y filtros por teclado. Self-hosted: un contenedor y un archivo SQLite.

Estado: **fase 1**. Login, perfiles, y notas con texto enriquecido en el canvas: se crean, mueven, redimensionan, enlazan, agrupan en zonas y se buscan con ⌘K.

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
| `web/`    | React 19 + Vite. El mapa de secciones se dibuja en SVG (`web/src/canvas/fluid.ts`). |

Variables: `PORT` (3210), `CANVIAN_DB` (`./data/canvian.db`), `CANVIAN_MEDIA` (imágenes, vídeo y audio de las notas; por defecto `media/` junto a la base, así que en Docker también quedan en el volumen `/data`), `CANVIAN_WEB_DIR` (por defecto `web/dist`).

## Datos de ejemplo

`npm run seed -w server` llena Personal y Trabajo con zonas, notas, tareas y enlaces de ejemplo (añade `-- --extra 400` para cientos de notas más). `npm run seed -w server -- --borrar` quita solo lo que creó.

## Atajos

Estos son los de fábrica. `Ctrl H` (`⌘H` en Mac) abre la lista con los que tengas, y en **Configuración** (`Ctrl ,` o el botón junto al perfil) se pueden cambiar; se guardan en el servidor.

| Atajo | Acción |
|-------|--------|
| Rueda | Acercar la sección o nota señalada; hacia atrás, alejar |
| Clic en una sección | Entrar en ella |
| Clic en una nota (o `Enter`) | Acercarse hasta que la celda se abre como hoja a pantalla completa |
| `Esc` / `Retroceso` | Salir: cierra la hoja o sube un nivel |
| Clic en una miga de pan | Volver a ese nivel; doble clic en una sección de las migas la renombra |
| `1` | Volver a Todo |
| `N` | Nota nueva en la sección señalada o en la que estás |
| `G` | Sección nueva en la que estás |
| `R` | Renombrar la sección señalada |
| Arrastrar una celda | Moverla a otra sección (soltándola sobre ella) o a un nivel de arriba (soltándola en las migas) |
| `T` | Convertir la nota señalada en tarea (o volver a nota) |
| `X` | Avanzar el estado de la tarea señalada: pendiente → en curso → hecha |
| `P` | Propiedades de la nota señalada: tipo, estado, prioridad, fecha y propiedades propias del perfil (texto, opciones, número, fecha, casilla, enlace) |
| `Supr` | Borrar la nota o sección señalada (lo que había dentro de una sección pasa a su madre) |
| En la hoja de una nota | Escribir; arriba, hacer tarea, propiedades y borrar; abajo, sus enlaces (`+ Enlazar` busca otra nota, `×` quita el enlace) |
| `A` | Vista de tareas: todas las tareas activas del perfil en una lista, agrupadas por estado, fecha o sección (`Tab` cambia). `↑`/`↓` para moverse, `Enter` abre, `X` avanza el estado, `N` crea una tarea, `Esc` vuelve al mapa |
| `F` | Linterna: filtra el mapa en vivo. Palabras sueltas (`-palabra` para excluir, `"frase exacta"`), `tipo:tarea`, `estado:pendiente\|curso\|hecha` (o `-hecha`), `prio:alta`, `vence:hoy\|semana\|vencida\|<7d`, `zona:viaje`, `#etiqueta`, `enlazado:"Plan de viaje" prof:2` y `<propiedad>:<valor>`. `Enter` la pliega, `Esc` la apaga |
| `Tab` (con la linterna) | Cambia el modo: atenuar (lo demás se apaga) u ocultar (lo demás encoge) |
| `⌘/Ctrl S` (en la linterna) | Guarda la lente; se abre luego con `⇧1`…`⇧9` o desde la lista al abrir `F` vacía |
| `B` | Elegir el fondo del perfil (liso, estrellas, luciérnagas, aurora) |
| `E` | Laboratorio: encender o apagar las ideas en prueba |
| Arrastrar archivos `.md` | Importarlos como notas en la sección en la que estás; los `[[enlaces]]` entre ellas se convierten en enlaces |
| Pegar o arrastrar imágenes, vídeo o audio | Dentro de una nota abierta, se añaden donde está el cursor o donde los sueltas. Sobre el mapa, crean una nota nueva con ellos. Hasta 200 MB por archivo |
| `⌘/Ctrl ⇧ E` | Exportar el perfil a JSON Canvas (`.canvas`, se abre en Obsidian) |
| `⌘/Ctrl K` | Buscar notas y abrirlas, o crear una |
| `⌘/Ctrl ⇧ P` | Cambiar de perfil, crear uno o cerrar sesión |
