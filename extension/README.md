# Extensión de Canvian para el navegador

Extensión de Chrome (Manifest V3; vale también en Edge, Brave…) con dos cosas:

- **Recortador** (como Obsidian Web Clipper): el icono de Canvian, `Alt ⇧ C` o el menú del botón derecho. Coge la página (el artículo, con Readability), lo seleccionado o solo el enlace, lo pasa a Markdown (Turndown) y lo guarda como nota en la carpeta que elijas (por defecto, «Recortes»), con las propiedades Fuente, Autor y Publicado y las etiquetas que pongas.
- **Tareas en Outlook** (Outlook en la web): abajo a la derecha, «Tareas» enseña las tareas de Canvian vinculadas al hilo abierto, con su estado, fecha, prioridad y nota. Se cambia el estado con un clic, se crean tareas nuevas para el hilo o se vincula una que ya existe, y «↗» la abre en Canvian.

## Instalar

Lo fácil: en Canvian, **Configuración › Extensión del navegador › Descargar extensión**. El .zip ya lleva la dirección y la llave. Descomprímelo, abre `chrome://extensions`, enciende el modo de desarrollador y «Cargar descomprimida».

Desde esta carpeta: «Cargar descomprimida» con `extension/` y escribe la dirección y la llave en las opciones (la llave sale en esa misma sección de Configuración).

## Cómo funciona

- Habla con el servidor en `/ext/…` con `Authorization: Bearer <llave>` (`server/src/extension/routes.ts`). Las llamadas las hace el service worker (`background.js`); el script de Outlook se las pide por mensajes.
- Una tarea vinculada es una casilla con id de bloque (`- [ ] … ^abc123`), así se encuentra aunque cambie la nota. El vínculo se guarda en la tabla `mail_links`.
- El hilo se reconoce por el id de la dirección de Outlook (`/mail/…/id/<id>`) o, si una respuesta trae otro, por el asunto sin «RE:», «RV:», «FW:»…
- «Abrir en Canvian» usa `#nota/<perfil>/<nota>/<bloque>`, que la web abre y lleva hasta la casilla.

`vendor/` trae Readability (Apache 2.0, Mozilla), Turndown y turndown-plugin-gfm (MIT), sin cambios.
