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
| `web/`    | React 19 + Vite + React Flow. |

Variables: `PORT` (3210), `CANVIAN_DB` (`./data/canvian.db`), `CANVIAN_WEB_DIR` (por defecto `web/dist`).

## Atajos

| Atajo | Acción |
|-------|--------|
| Doble clic en el vacío | Crear una nota ahí |
| Doble clic en una nota / `Enter` | Editarla (`Esc` para salir; si queda vacía, se borra) |
| Arrastrar desde un punto del borde | Enlazar con otra nota, o crear una nueva enlazada si sueltas en el vacío |
| `B` | Elegir el fondo del perfil (liso, puntos, cuadrícula, estrellas, luciérnagas, aurora) |
| `T` | Convertir las notas seleccionadas en tareas (o volver a notas) |
| `X` | Avanzar el estado de la tarea: pendiente → en curso → hecha |
| `F` | Linterna: filtra el canvas (`tipo:tarea`, `estado:pendiente\|curso\|hecha`); `Enter` la fija, `Esc` la apaga |
| `E` | Laboratorio: encender o apagar las ideas en prueba |
| `G` | Agrupar las notas seleccionadas en una zona (o crear una zona vacía) |
| `Supr` / `Retroceso` | Borrar lo seleccionado |
| `⇧` + clic | Seleccionar varias notas |
| `1` | Encajar todo el canvas |
| `⌘/Ctrl K` | Buscar notas y saltar a ellas, o crear una |
| `⌘/Ctrl ⇧ P` | Cambiar de perfil, crear uno o cerrar sesión |
