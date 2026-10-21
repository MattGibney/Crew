import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import { App } from './App.jsx';

// No StrictMode: each mount owns one live event stream and one optional media session.
createRoot(document.getElementById('root')).render(<App />);
