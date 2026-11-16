import { createRoot } from 'react-dom/client';
import { App } from './App';
// Bundled into dist/assets, so the font loads from this origin under font-src 'self'.
import '@fontsource-variable/hanken-grotesk/wght.css';
import './style.css';

createRoot(document.getElementById('root')!).render(<App />);
