let buffer = Buffer.alloc(0);
let openedUri = '';

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/iu);
    if (!match?.[1]) process.exit(2);
    const length = Number(match[1]);
    const end = headerEnd + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString('utf8'));
    buffer = buffer.subarray(end);
    handle(message);
  }
}

function handle(message) {
  if (message.method === 'initialize') {
    respond(message.id, {
      capabilities: {
        definitionProvider: true,
        referencesProvider: true,
        diagnosticProvider: {interFileDependencies: false, workspaceDiagnostics: false},
      },
    });
    return;
  }
  if (message.method === 'textDocument/didOpen') {
    openedUri = message.params.textDocument.uri;
    return;
  }
  if (message.method === 'textDocument/definition') {
    respond(message.id, [
      {uri: openedUri, range: range(1, 2, 1, 8)},
      {uri: 'file:///etc/hosts', range: range(0, 0, 0, 1)},
    ]);
    return;
  }
  if (message.method === 'textDocument/references') {
    respond(message.id, [
      {uri: openedUri, range: range(2, 0, 2, 6)},
      {targetUri: openedUri, targetSelectionRange: range(3, 0, 3, 6)},
    ]);
    return;
  }
  if (message.method === 'textDocument/diagnostic') {
    respond(message.id, {items: [{
      range: range(4, 1, 4, 7),
      severity: 2,
      source: 'fake\nserver',
      code: 'W1',
      message: 'example\tdiagnostic',
    }]});
    return;
  }
  if (message.method === 'shutdown') {
    respond(message.id, null);
    return;
  }
  if (message.method === 'exit') process.exit(0);
}

function range(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: {line: startLine, character: startCharacter},
    end: {line: endLine, character: endCharacter},
  };
}

function respond(id, result) {
  const content = JSON.stringify({jsonrpc: '2.0', id, result});
  process.stdout.write(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`);
}
