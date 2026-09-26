# Canvian

Canvas infinito de notas y tareas enlazadas, con perfiles (Personal, Trabajo…) y filtros por teclado. Self-hosted: un contenedor y un archivo SQLite.

Estado: **fase 0**. Hay login, perfiles y un canvas vacío que recuerda la vista de cada perfil. Las notas llegan en la fase 1.

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
| `⌘/Ctrl ⇧ P` | Cambiar de perfil, crear uno o cerrar sesión |
