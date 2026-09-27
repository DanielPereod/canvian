import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/silkscreen/400.css';
import '@fontsource-variable/jetbrains-mono';
// Letras de los temas: el navegador solo las descarga si el tema las usa.
import '@fontsource-variable/fraunces';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/400-italic.css';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/young-serif/400.css';
import '@fontsource-variable/inter';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';
import './canvas/canvas.css';
import './app.css';
import './canvas/properties.css';
import './lab/experiments.css';
import './canvas/lens.css';
import './canvas/sections.css';
import './design/themes.css';
import { startTheme } from './theme';
import { App } from './App';

startTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
