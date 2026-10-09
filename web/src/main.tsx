import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/instrument-sans/wght-italic.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/silkscreen/400.css';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/jetbrains-mono/wght-italic.css';
// Letras de los temas: el navegador solo las descarga si el tema las usa.
import '@fontsource-variable/fraunces';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/400-italic.css';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/archivo/wght-italic.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/400-italic.css';
import '@fontsource/young-serif/400.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/inter/wght-italic.css';
import '@fontsource-variable/jost';
import '@fontsource-variable/jost/wght-italic.css';
import '@fontsource-variable/newsreader';
import './fonts';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';
import './canvas/canvas.css';
import './app.css';
import './canvas/properties.css';
import './canvas/pieces.css';
import './canvas/lens.css';
import './canvas/sections.css';
import './design/themes.css';
import './canvas/biblioteca.css';
import './canvas/collection.css';
import './canvas/timeline.css';
import { startTheme } from './theme';
import { startTypography } from './typography';
import { startLang, useLang } from './i18n';
import { App } from './App';

startLang();
startTheme();
startTypography();

// Al cambiar de idioma se vuelve a pintar todo con los textos nuevos.
function Root() {
  useLang();
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
