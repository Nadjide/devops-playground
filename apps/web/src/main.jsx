import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createDemoClient } from './session/demo-client.js';
import './styles/tokens.css';
import './styles/app.css';

const client = createDemoClient();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
