import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/silkscreen/400.css';
import '@fontsource-variable/jetbrains-mono';
import '@xyflow/react/dist/base.css';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';
import './canvas/canvas.css';
import './app.css';
import './canvas/properties.css';
import './lab/experiments.css';
import './canvas/lens.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
