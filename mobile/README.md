# Canvian para Android

Envoltorio de [Capacitor](https://capacitorjs.com) alrededor de la web de tu
servidor. No copia `web/`: la app abre `https://tu-servidor/`, así que todo lo
que se despliega llega a la vez al navegador y al móvil.

- `www/index.html`: la pantalla de arranque. Pide la dirección del servidor,
  comprueba `/health` y abre la web. Con la dirección ya guardada entra
  directamente; si no responde, vuelve a pedirla.
- `ServerPlugin.java`: guarda la dirección y decide qué se abre dentro de la
  app (tu servidor) y qué en el navegador (los demás enlaces).
- La web se reconoce dentro de la app por `CanvianApp` en el agente de usuario
  (`web/src/native.ts`) y entonces muestra Configuración › General › Servidor.

## Compilar

GitHub Actions (`.github/workflows/android.yml`) compila el APK en cada PR que
toca `mobile/` y, en main, lo publica en la release `android`.

En local hace falta el SDK de Android y Java 21:

```sh
cd mobile
npm ci
npm run apk   # → android/app/build/outputs/apk/debug/app-debug.apk
```

El APK va firmado con `android/app/canvian.keystore` (contraseña `canvian`),
que está en el repo a propósito: así cada versión se instala encima de la
anterior.
