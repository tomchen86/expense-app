const mode = process.argv[2];
let sequence = 1;

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

emit({
  schemaVersion: 1,
  type: 'hello',
  sequence: sequence++,
  protocol: 'harness-jsonl-v1',
});

if (mode === 'success') {
  emit({
    schemaVersion: 1,
    type: 'progress',
    sequence: sequence++,
    phase: 'tool',
  });
  emit({
    schemaVersion: 1,
    type: 'result',
    sequence: sequence++,
    outputSlot: 'primary',
  });
} else if (mode === 'cancel-ack') {
  process.once('SIGTERM', () => {
    emit({ schemaVersion: 1, type: 'cancel-ack', sequence: sequence++ });
    setTimeout(() => process.exit(0), 10);
  });
  setInterval(() => {}, 1_000);
} else if (mode === 'cancel-ignore') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else {
  process.exitCode = 2;
}
