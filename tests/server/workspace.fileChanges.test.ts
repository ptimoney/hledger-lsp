import { URI } from 'vscode-uri';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceManager } from '../../src/server/workspace';
import { HledgerParser } from '../../src/parser';

/**
 * Issue #31: the workspace cache must follow changes made on disk to files
 * that are not open in the editor (reported via workspace/didChangeWatchedFiles).
 */
describe('WorkspaceManager.applyFileChanges', () => {
  const dir = path.resolve('/ws');
  const uri = (name: string) => URI.file(path.join(dir, name));
  let files: Map<string, string>;
  let manager: WorkspaceManager;

  const reader = (u: URI) => {
    const content = files.get(u.toString());
    return content === undefined ? null : TextDocument.create(u.toString(), 'hledger', 1, content);
  };
  const resolver = (p: string, base: URI) => [URI.file(path.join(path.dirname(base.fsPath), p))];

  const declared = () =>
    [...(manager.parseWorkspace()?.accounts.values() ?? [])].filter(a => a.declared).map(a => a.name);

  async function init(initial: Record<string, string>) {
    files = new Map(Object.entries(initial).map(([k, v]) => [uri(k).toString(), v]));
    manager = new WorkspaceManager();
    await manager.initializeWithFiles(
      Object.keys(initial).map(uri), new HledgerParser(), reader, undefined, resolver
    );
    manager.parseWorkspace(); // warm the caches, as the server does
  }

  test('picks up an external edit to an unopened included file', async () => {
    await init({
      'main.journal': 'include accounts.journal\n',
      'accounts.journal': 'account assets:bank\n',
    });
    expect(declared()).not.toContain('expenses:medical');

    files.set(uri('accounts.journal').toString(), 'account assets:bank\naccount expenses:medical\n');
    await manager.applyFileChanges([{ uri: uri('accounts.journal'), type: 'changed' }]);

    expect(declared()).toContain('expenses:medical');
  });

  test('follows a newly added include line in a changed file', async () => {
    await init({
      'main.journal': 'include a.journal\n',
      'a.journal': 'account assets:a\n',
      'b.journal': 'account assets:b\n',
    });
    expect(declared()).not.toContain('assets:b');

    files.set(uri('a.journal').toString(), 'account assets:a\ninclude b.journal\n');
    await manager.applyFileChanges([{ uri: uri('a.journal'), type: 'changed' }]);

    expect(declared()).toContain('assets:b');
    expect(manager.getRootForFile(uri('b.journal'))?.toString()).toBe(uri('main.journal').toString());
  });

  test('invalidateFile also refreshes the include edges of an edited open file', async () => {
    await init({
      'main.journal': 'include a.journal\n',
      'a.journal': 'account assets:a\n',
      'b.journal': 'account assets:b\n',
    });

    files.set(uri('a.journal').toString(), 'account assets:a\ninclude b.journal\n');
    manager.invalidateFile(uri('a.journal'));

    expect(declared()).toContain('assets:b');
  });

  test('a created file that an existing include points at joins the workspace', async () => {
    await init({
      'main.journal': 'include new.journal\naccount assets:main\n',
    });
    expect(declared()).not.toContain('assets:new');

    files.set(uri('new.journal').toString(), 'account assets:new\n');
    await manager.applyFileChanges([{ uri: uri('new.journal'), type: 'created' }]);

    expect(declared()).toContain('assets:new');
  });

  test('a deleted included file leaves the workspace', async () => {
    await init({
      'main.journal': 'include gone.journal\naccount assets:main\n',
      'gone.journal': 'account assets:gone\n',
    });
    expect(declared()).toContain('assets:gone');

    files.delete(uri('gone.journal').toString());
    await manager.applyFileChanges([{ uri: uri('gone.journal'), type: 'deleted' }]);

    expect(declared()).toEqual(['assets:main']);
    expect(manager.isKnownFile(uri('gone.journal'))).toBe(false);
  });
});
