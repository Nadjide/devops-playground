export function formatTime(iso) {
  if (!iso) {
    return 'never';
  }
  const date = new Date(iso);
  return date.toISOString().slice(11, 19) + ' UTC';
}

export function sourceLabel(source) {
  return {
    simulator: 'Simulated',
    docker: 'Docker',
    process: 'Process',
    probe: 'Probe',
    emulator: 'Emulator',
  }[source] ?? source;
}
