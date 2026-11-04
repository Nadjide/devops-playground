import { SessionProvider } from './session/SessionContext.jsx';
import { SessionActionsProvider } from './session/SessionActions.jsx';
import { TopBar } from './components/TopBar.jsx';
import { Workbench } from './components/Workbench.jsx';
import { OperationAnnouncer } from './components/OperationAnnouncer.jsx';

export function App({ client }) {
  return (
    <SessionProvider client={client}>
      <SessionActionsProvider>
        <div className="app">
          <TopBar />
          <Workbench />
          <OperationAnnouncer />
        </div>
      </SessionActionsProvider>
    </SessionProvider>
  );
}
