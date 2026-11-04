import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles/tokens.css';
import './styles/app.css';

/**
 * The static build always starts in Demo mode with no backend request. Only a
 * packaged portal in Local Docker mode marks the page, and only then is the
 * local client loaded.
 */
async function createClient() {
  const mode = document.querySelector('meta[name="devops-playground-mode"]')?.getAttribute('content');
  if (mode === 'local') {
    const { createLocalClient } = await import('./session/local-client.js');
    return createLocalClient();
  }
  const { createDemoClient } = await import('./session/demo-client.js');
  return createDemoClient();
}

createClient().then((client) => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
});
