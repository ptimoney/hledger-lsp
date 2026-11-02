/**
 * Additional tests for workspace.ts to improve coverage
 * Targets uncovered lines: 279-280, 508-532, 593-596, 652-658, 669, 724, 729, 744-765, 950, 987
 */
import { URI } from 'vscode-uri';
import { WorkspaceManager } from '../../src/server/workspace';
import { HledgerParser } from '../../src/parser';
import { FileReader } from '../../src/types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection } from 'vscode-languageserver/node';
import { logger } from '../../src/utils/logger';

// Mock the Connection interface
const mockConnection = {
  console: {
    log: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
} as unknown as Connection;

describe('WorkspaceManager - Coverage Tests', () => {
  let manager: WorkspaceManager;
  let parser: HledgerParser;

  beforeEach(() => {
    manager = new WorkspaceManager();
    parser = new HledgerParser();
    jest.clearAllMocks();
    // Route the global logger through the mock so log assertions still work.
    logger.init((mockConnection as any).console);
  });

  describe('getAllWorkspaceFiles', () => {
    test('should return empty array when no root file', async () => {
      // Don't initialize - no root file
      const files = manager.getAllWorkspaceFiles();
      expect(files).toEqual([]);
    });

    test('should return all files in include order from root', async () => {
      const files: Record<string, string> = {
        'file:///workspace/main.journal': `include sub.journal`,
        'file:///workspace/sub.journal': `2024-01-01 * Test
    Assets:Bank  $100
    Income:Salary`
      };

      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      const includeResolver = (includePath: string, baseUri: URI) => {
        if (includePath === 'sub.journal') {
          return [URI.parse('file:///workspace/sub.journal')];
        }
        return [];
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/main.journal'), URI.parse('file:///workspace/sub.journal')],
        parser,
        fileReader,
        mockConnection,
        includeResolver
      );

      const workspaceFiles = manager.getAllWorkspaceFiles();
      expect(workspaceFiles.length).toBe(2);
      expect(workspaceFiles[0].toString()).toBe('file:///workspace/main.journal');
      expect(workspaceFiles[1].toString()).toBe('file:///workspace/sub.journal');
    });
  });

  describe('getIncludeGraph', () => {
    test('should return include graph as string map', async () => {
      const files: Record<string, string> = {
        'file:///workspace/main.journal': `include expenses.journal
include income.journal`,
        'file:///workspace/expenses.journal': `2024-01-01 * Food
    Expenses:Food  $50
    Assets:Bank`,
        'file:///workspace/income.journal': `2024-01-15 * Salary
    Income:Salary  -$1000
    Assets:Bank`
      };

      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      const includeResolver = (includePath: string, _baseUri: URI) => {
        if (includePath === 'expenses.journal') {
          return [URI.parse('file:///workspace/expenses.journal')];
        }
        if (includePath === 'income.journal') {
          return [URI.parse('file:///workspace/income.journal')];
        }
        return [];
      };

      await manager.initializeWithFiles(
        [
          URI.parse('file:///workspace/main.journal'),
          URI.parse('file:///workspace/expenses.journal'),
          URI.parse('file:///workspace/income.journal')
        ],
        parser,
        fileReader,
        mockConnection,
        includeResolver
      );

      const graph = manager.getIncludeGraph();
      expect(graph).toBeInstanceOf(Map);
      expect(graph.get('file:///workspace/main.journal')).toContain('file:///workspace/expenses.journal');
      expect(graph.get('file:///workspace/main.journal')).toContain('file:///workspace/income.journal');
    });
  });

  describe('hasDocumentCached and getDocumentCacheSize', () => {
    test('should correctly report cache status', async () => {
      const files: Record<string, string> = {
        'file:///workspace/main.journal': `2024-01-01 * Test
    Assets:Bank  $100
    Income:Salary`
      };

      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/main.journal')],
        parser,
        fileReader,
        mockConnection
      );

      // After initialization, documents should be cached
      expect(manager.hasDocumentCached(URI.parse('file:///workspace/main.journal'))).toBe(true);
      expect(manager.getDocumentCacheSize()).toBeGreaterThanOrEqual(1);

      // Non-existent file should not be cached
      expect(manager.hasDocumentCached(URI.parse('file:///workspace/other.journal'))).toBe(false);
    });
  });

  describe('getCachedDocument', () => {
    test('should re-parse document when not in cache but in journal files', async () => {
      const files: Record<string, string> = {
        'file:///workspace/main.journal': `2024-01-01 * Test
    Assets:Bank  $100
    Income:Salary`
      };

      let readable = true;
      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (readable && content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/main.journal')],
        parser,
        fileReader,
        mockConnection
      );

      // Invalidate the file to clear cache (unreadable, so invalidateFile's
      // eager edge refresh can't repopulate it)
      readable = false;
      manager.invalidateFile(URI.parse('file:///workspace/main.journal'));
      readable = true;

      // getCachedDocument should re-parse the file
      const doc = manager.getCachedDocument(URI.parse('file:///workspace/main.journal'));
      expect(doc).not.toBeNull();
      expect(doc?.transactions.length).toBeGreaterThan(0);

      // Verify re-parsing was logged
      expect(mockConnection.console.info).toHaveBeenCalledWith(
        expect.stringContaining('Re-parsed and cached')
      );
    });

    test('should return null for unknown file', async () => {
      const files: Record<string, string> = {
        'file:///workspace/main.journal': `2024-01-01 * Test
    Assets:Bank  $100
    Income:Salary`
      };

      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/main.journal')],
        parser,
        fileReader,
        mockConnection
      );

      // Try to get document for file not in journal files
      const doc = manager.getCachedDocument(URI.parse('file:///workspace/unknown.journal'));
      expect(doc).toBeNull();
    });

    test('should return null when file cannot be read', async () => {
      let shouldFail = false;
      const fileReader: FileReader = (uri: URI) => {
        if (shouldFail) return null;
        if (uri.toString().includes('main.journal')) {
          return TextDocument.create(uri.toString(), 'hledger', 1, `2024-01-01 * Test\n    Assets:Bank  $100`);
        }
        return null;
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/main.journal')],
        parser,
        fileReader,
        mockConnection
      );

      // Make file reader fail, then invalidate to clear cache
      shouldFail = true;
      manager.invalidateFile(URI.parse('file:///workspace/main.journal'));

      const doc = manager.getCachedDocument(URI.parse('file:///workspace/main.journal'));
      expect(doc).toBeNull();
    });
  });

  describe('parseFromFile', () => {
    test('should parse from file in workspace include graph', async () => {
      const files: Record<string, string> = {
        'file:///workspace/main.journal': `include sub.journal`,
        'file:///workspace/sub.journal': `2024-01-01 * Test
    Assets:Bank  $100
    Income:Salary`
      };

      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      const includeResolver = (includePath: string, _baseUri: URI) => {
        if (includePath === 'sub.journal') {
          return [URI.parse('file:///workspace/sub.journal')];
        }
        return [];
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/main.journal'), URI.parse('file:///workspace/sub.journal')],
        parser,
        fileReader,
        mockConnection,
        includeResolver
      );

      // Parse from main.journal - should include sub.journal
      const doc = manager.parseFromFile(URI.parse('file:///workspace/main.journal'));

      expect(doc.transactions.length).toBe(1);
    });

    test('should warn when document cannot be retrieved in merge', async () => {
      const files: Record<string, string> = {
        'file:///workspace/main.journal': `include sub.journal`,
        'file:///workspace/sub.journal': `2024-01-01 * Test\n    Assets:Bank  $100`
      };

      let failOnSub = false;
      const fileReader: FileReader = (uri: URI) => {
        if (failOnSub && uri.toString().includes('sub.journal')) {
          return null;
        }
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      const includeResolver = (includePath: string, _baseUri: URI) => {
        if (includePath === 'sub.journal') {
          return [URI.parse('file:///workspace/sub.journal')];
        }
        return [];
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/main.journal'), URI.parse('file:///workspace/sub.journal')],
        parser,
        fileReader,
        mockConnection,
        includeResolver
      );

      // Make sub.journal unreadable and clear caches
      failOnSub = true;
      manager.invalidateFile(URI.parse('file:///workspace/sub.journal'));

      // Parse from file should warn about missing document
      manager.parseFromFile(URI.parse('file:///workspace/main.journal'));

      expect(mockConnection.console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not get document for')
      );
    });

    test('should handle file not tracked in workspace but still traverse graph', async () => {
      // This test verifies parseFromFile behavior when file is in traversal
      // but getCachedDocument returns null
      const files: Record<string, string> = {
        'file:///workspace/main.journal': `2024-01-01 * Test
    Assets:Bank  $100
    Income:Salary`
      };

      let allowRead = true;
      const fileReader: FileReader = (uri: URI) => {
        if (!allowRead && uri.toString().includes('main.journal')) {
          return null;
        }
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/main.journal')],
        parser,
        fileReader,
        mockConnection
      );

      // Make unreadable and invalidate
      allowRead = false;
      manager.invalidateFile(URI.parse('file:///workspace/main.journal'));

      // Parse from file - will try to get cached doc which will fail
      manager.parseFromFile(URI.parse('file:///workspace/main.journal'));

      expect(mockConnection.console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not get document for')
      );
    });
  });

  describe('parseWorkspace with re-parsing', () => {
    test('should track re-parsed files count', async () => {
      const files: Record<string, string> = {
        'file:///workspace/main.journal': `include sub.journal`,
        'file:///workspace/sub.journal': `2024-01-01 * Test
    Assets:Bank  $100
    Income:Salary`
      };

      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      const includeResolver = (includePath: string, _baseUri: URI) => {
        if (includePath === 'sub.journal') {
          return [URI.parse('file:///workspace/sub.journal')];
        }
        return [];
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/main.journal'), URI.parse('file:///workspace/sub.journal')],
        parser,
        fileReader,
        mockConnection,
        includeResolver
      );

      // First parse - everything from cache
      manager.parseWorkspace();

      // Invalidate one file
      manager.invalidateFile(URI.parse('file:///workspace/sub.journal'));

      // Force re-parse to get the "re-parsed" count
      manager.parseWorkspace(true);

      // Should log merge info with re-parse count
      expect(mockConnection.console.info).toHaveBeenCalledWith(
        expect.stringMatching(/re-parsed/)
      );
    });
  });

  describe('cycle detection in tree', () => {
    test('should detect cycles in workspace tree', async () => {
      // Create a structure with a root that leads into a cycle: root → a → b → a
      const files: Record<string, string> = {
        'file:///workspace/root.journal': `include a.journal`,
        'file:///workspace/a.journal': `include b.journal`,
        'file:///workspace/b.journal': `include a.journal`
      };

      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      const includeResolver = (includePath: string, _baseUri: URI) => {
        if (includePath === 'a.journal') {
          return [URI.parse('file:///workspace/a.journal')];
        }
        if (includePath === 'b.journal') {
          return [URI.parse('file:///workspace/b.journal')];
        }
        return [];
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/root.journal'), URI.parse('file:///workspace/a.journal'), URI.parse('file:///workspace/b.journal')],
        parser,
        fileReader,
        mockConnection,
        includeResolver
      );

      // Get workspace tree - should handle cycle
      const tree = manager.getWorkspaceTree();
      expect(tree).toContain('(cycle)');
    });

    test('should detect cycles in structured tree', async () => {
      // Create a structure with a root that leads into a cycle: root → a → b → a
      const files: Record<string, string> = {
        'file:///workspace/root.journal': `include a.journal`,
        'file:///workspace/a.journal': `include b.journal`,
        'file:///workspace/b.journal': `include a.journal`
      };

      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      const includeResolver = (includePath: string, _baseUri: URI) => {
        if (includePath === 'a.journal') {
          return [URI.parse('file:///workspace/a.journal')];
        }
        if (includePath === 'b.journal') {
          return [URI.parse('file:///workspace/b.journal')];
        }
        return [];
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/root.journal'), URI.parse('file:///workspace/a.journal'), URI.parse('file:///workspace/b.journal')],
        parser,
        fileReader,
        mockConnection,
        includeResolver
      );

      // Get structured tree - should handle cycle
      const tree = manager.getWorkspaceTreeStructured();
      const cycleEntry = tree.find(e => e.display.includes('(cycle)'));
      expect(cycleEntry).toBeDefined();
    });
  });

  describe('no root candidates', () => {
    test('should return null root when all files are included by others', async () => {
      // Create a purely circular structure where every file is included by another
      const files: Record<string, string> = {
        'file:///workspace/a.journal': `include b.journal`,
        'file:///workspace/b.journal': `include a.journal`
      };

      const fileReader: FileReader = (uri: URI) => {
        const content = files[uri.toString()];
        if (content) {
          return TextDocument.create(uri.toString(), 'hledger', 1, content);
        }
        return null;
      };

      const includeResolver = (includePath: string, _baseUri: URI) => {
        if (includePath === 'b.journal') {
          return [URI.parse('file:///workspace/b.journal')];
        }
        if (includePath === 'a.journal') {
          return [URI.parse('file:///workspace/a.journal')];
        }
        return [];
      };

      await manager.initializeWithFiles(
        [URI.parse('file:///workspace/a.journal'), URI.parse('file:///workspace/b.journal')],
        parser,
        fileReader,
        mockConnection,
        includeResolver
      );

      // Both files include each other, so both have parents
      // No root candidate exists - workspace features are disabled
      const diagnostics = manager.getDiagnosticInfo();
      expect(diagnostics.rootFile).toBeNull();
    });
  });
});
