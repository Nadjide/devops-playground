import { SessionProvider } from './session/SessionContext.jsx';
import { TopBar } from './components/TopBar.jsx';
import { Workbench } from './components/Workbench.jsx';

export function App({ client }) {
  return (
    <SessionProvider client={client}>
      <div className="app">
        <TopBar />
        <Workbench />
      </div>
    </SessionProvider>
  );
}
