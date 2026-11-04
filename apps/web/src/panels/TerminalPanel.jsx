import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { MAX_COMMAND_LENGTH } from '@devops-playground/lab-core';
import { useSessionClient } from '../session/SessionContext.jsx';
import { useSessionActions } from '../session/SessionActions.jsx';
import { useTerminalState } from '../terminal/context.jsx';
import { formatLines, runTerminalCommand } from '../terminal/commands.js';

const PROMPT = '\x1b[36m$\x1b[0m ';
const WELCOME = '\x1b[90mWorkbench command terminal. Type help to list supported commands.\x1b[0m';
// Printable input only; control characters from paste are dropped.
// eslint-disable-next-line no-control-regex
const NON_PRINTABLE = /[\u0000-\u001f\u007f-\u009f]/g;

const theme = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78',
  black: '#0d1117',
  brightBlack: '#8b949e',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  cyan: '#56d4dd',
};

export function TerminalPanel() {
  const client = useSessionClient();
  const { requestLifecycle } = useSessionActions();
  const terminalState = useTerminalState();
  const hostRef = useRef(null);
  // Keep the latest collaborators without recreating the terminal.
  const depsRef = useRef({ client, requestLifecycle });
  useEffect(() => {
    depsRef.current = { client, requestLifecycle };
  }, [client, requestLifecycle]);

  useEffect(() => {
    const host = hostRef.current;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      scrollback: 1000,
      screenReaderMode: true,
      theme,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

    let line = '';
    let busy = false;
    let disposed = false;

    const write = (text) => {
      terminalState.append(text);
      terminal.write(text);
    };
    const showPrompt = () => write(`\r\n${PROMPT}`);
    const replaceLine = (value) => {
      line = value;
      write(`\r\x1b[2K${PROMPT}${line}`);
    };

    const transcript = terminalState.transcript();
    if (transcript.length === 0) {
      write(WELCOME);
      showPrompt();
    } else {
      for (const chunk of transcript) {
        terminal.write(chunk);
      }
    }

    async function submit() {
      const command = line;
      line = '';
      terminalState.history.push(command);
      busy = true;
      write('\r\n');
      const result = await runTerminalCommand(command, depsRef.current);
      busy = false;
      if (disposed) {
        return;
      }
      if (result.clear) {
        terminalState.clear();
        terminal.clear();
        write(`\r\x1b[2K${PROMPT}`);
        return;
      }
      for (const text of formatLines(result.lines)) {
        write(`${text}\r\n`);
      }
      write(PROMPT);
    }

    function append(text) {
      const room = MAX_COMMAND_LENGTH - line.length;
      const accepted = text.replace(NON_PRINTABLE, '').slice(0, Math.max(0, room));
      if (accepted) {
        line += accepted;
        write(accepted);
      }
    }

    const dataSubscription = terminal.onData((data) => {
      if (busy) {
        return;
      }
      if (data === '\r') {
        submit();
      } else if (data === '\x7f' || data === '\b') {
        if (line) {
          line = line.slice(0, -1);
          write('\b \b');
        }
      } else if (data === '\x03') {
        write('^C');
        line = '';
        terminalState.history.reset();
        showPrompt();
      } else if (data === '\x0c') {
        terminalState.clear();
        terminal.clear();
        replaceLine(line);
      } else if (data === '\x1b[A') {
        replaceLine(terminalState.history.previous());
      } else if (data === '\x1b[B') {
        replaceLine(terminalState.history.next());
      } else if (data.startsWith('\x1b')) {
        // Other escape sequences (cursor keys, function keys) are not editable input.
      } else if (/[\r\n]/.test(data)) {
        const parts = data.split(/\r\n|\r|\n/);
        const meaningful = parts.slice(0, -1).filter((part) => part.trim()).length + (parts.at(-1).trim() ? 1 : 0);
        if (meaningful > 1) {
          write('\r\n\x1b[31mMultiline input is not supported. Paste one command at a time.\x1b[0m');
          line = '';
          showPrompt();
          return;
        }
        append(parts.join(''));
        if (!parts.at(-1).trim()) {
          submit();
        }
      } else {
        append(data);
      }
    });

    const fitTerminal = () => {
      try {
        fit.fit();
      } catch {
        // The host may be hidden while panels animate; the next resize fits it.
      }
    };
    fitTerminal();
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
    };
  }, [terminalState]);

  return (
    <div className="terminal-panel">
      <p className="small muted">
        Supported commands map to the same operations as the workbench buttons. No host shell is available.
      </p>
      <div ref={hostRef} className="terminal-host" aria-label="Command terminal" data-testid="terminal-host" />
    </div>
  );
}
