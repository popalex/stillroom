import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, savedTheme } from './theme';
// Bundled into dist/assets, so the font loads from this origin under font-src 'self'.
import '@fontsource-variable/hanken-grotesk/wght.css';
import './style.css';

// Before the first render, so no screen flashes the other theme.
applyTheme(savedTheme());
createRoot(document.getElementById('root')!).render(<App />);
