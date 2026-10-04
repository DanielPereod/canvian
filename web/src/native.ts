// La app de Android (mobile/) no lleva la web dentro: abre esta misma web
// desde tu servidor y se reconoce por el agente de usuario. Así cada cambio
// llega a la vez a la web y al móvil.
export const inApp = typeof navigator !== 'undefined' && navigator.userAgent.includes('CanvianApp');

// Vuelve a la pantalla de la app donde se elige el servidor.
export function changeServer() {
  location.href = 'http://localhost/?cambiar';
}
