import { URI } from 'vscode-uri';
import { FileChangeType } from 'vscode-languageserver/node';
import { buildFileWatchers, toJournalFileChanges, CONFIG_FILE_NAME } from '../../src/server/fileWatchers';

describe('buildFileWatchers', () => {
  const folder = URI.file('/ws');

  test('uses relative patterns per folder when the client supports them', () => {
    const watchers = buildFileWatchers([folder], ['journals/*.journal'], true);
    expect(watchers).toEqual([
      { globPattern: { baseUri: folder.toString(), pattern: 'journals/*.journal' } },
      { globPattern: { baseUri: folder.toString(), pattern: `**/${CONFIG_FILE_NAME}` } },
    ]);
  });

  test('falls back to plain globs, anchoring relative patterns with **/', () => {
    const watchers = buildFileWatchers([folder], ['**/*.journal', 'journals/*.hledger'], false);
    expect(watchers.map(w => w.globPattern)).toEqual([
      '**/*.journal',
      '**/journals/*.hledger',
      `**/${CONFIG_FILE_NAME}`,
    ]);
  });
});

describe('toJournalFileChanges', () => {
  const a = URI.file('/ws/a.journal').toString();
  const b = URI.file('/ws/b.journal').toString();
  const cfg = URI.file(`/ws/${CONFIG_FILE_NAME}`).toString();

  test('maps change types and drops config-file events', () => {
    const result = toJournalFileChanges(
      [
        { uri: a, type: FileChangeType.Created },
        { uri: b, type: FileChangeType.Deleted },
        { uri: cfg, type: FileChangeType.Changed },
      ],
      () => false
    );
    expect(result.map(c => [c.uri.toString(), c.type])).toEqual([
      [a, 'created'],
      [b, 'deleted'],
    ]);
  });

  test('ignores "changed" events for documents open in the editor (in-memory wins)', () => {
    const result = toJournalFileChanges(
      [
        { uri: a, type: FileChangeType.Changed },
        { uri: b, type: FileChangeType.Deleted },
      ],
      u => u === a
    );
    expect(result.map(c => c.uri.toString())).toEqual([b]);
  });
});
