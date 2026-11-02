import { URI } from 'vscode-uri';
import fg from 'fast-glob';
import * as path from 'path';
import { HledgerParser } from '../parser/index';
import { ParsedDocument, Directive, FileReader } from '../types';
import { toFilePath, toFileUri, resolveIncludePaths } from '../utils/uri';
import { createEmptyParsedDocument, mergeParsedDocuments } from '../utils/documentMerge';
import { HledgerLspConfig, discoverConfigFile, loadConfigFile, resolveRootFile, mergeConfig } from './configFile';
import { logger } from '../utils/logger';

const wsLog = logger.withContext('Workspace');

/**
 * Function type for resolving include paths to URIs.
 * Used for dependency injection in WorkspaceManager to make testing easier.
 *
 * @param includePath - The include path from the directive (may be glob pattern, relative, or absolute)
 * @param baseUri - The URI of the file containing the include directive
 * @returns Array of resolved URIs for the include path
 */
export type IncludePathResolver = (includePath: string, baseUri: URI) => URI[];

export class WorkspaceManager {
  // Core state
  private workspaceFolders: URI[] = [];
  private journalFiles: Map<string, URI> = new Map();
  private includeGraph: Map<string, Map<string, URI>> = new Map(); // file → files it includes
  private reverseGraph: Map<string, Map<string, URI>> = new Map(); // file → files that include it
  private rootFile: URI | null = null;
  private workspaceCache: ParsedDocument | null = null; // single cached workspace state
  private documentCache: Map<string, ParsedDocument> = new Map(); // per-file parsed documents from graph building

  // Configuration
  private config: Required<HledgerLspConfig> | null = null;
  private configPath: URI | null = null;

  // Performance metrics
  private metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    totalParseTime: 0, // milliseconds
    parseCount: 0,
    initializationTime: 0
  };

  // Dependencies
  private parser!: HledgerParser;
  private fileReader!: FileReader;
  private includePathResolver?: IncludePathResolver;

  /**
   * Initialize the WorkspaceManager with workspace folders and dependencies.
   * This discovers all journal files, builds the include graph, and identifies root files.
   * Optionally loads configuration from .hledger-lsp.json if present.
   */
  async initialize(
    workspaceFolders: URI[],
    parser: HledgerParser,
    fileReader: FileReader,
    _connection?: unknown,
    runtimeConfig?: Partial<HledgerLspConfig>
  ): Promise<void> {
    const startTime = Date.now();

    this.workspaceFolders = workspaceFolders;
    this.parser = parser;
    this.fileReader = fileReader;

    // Try to discover and load config file
    await this.loadConfig(runtimeConfig);

    // Discover all journal files in workspace
    for (const folder of workspaceFolders) {
      const files = await this.discoverJournalFiles(folder);
      for (const file of files) {
        this.journalFiles.set(file.toString(), file);
      }
    }

    wsLog.log(`Discovered ${this.journalFiles.size} journal files in workspace`);

    // Warn if workspace is very large
    if (this.journalFiles.size > 100) {
      wsLog.warn(
        `Large workspace detected (${this.journalFiles.size} files). ` +
        `Consider using exclude patterns in .hledger-lsp.json to improve performance.`
      );
    }

    // Build include graph
    await this.buildIncludeGraph();

    // Identify root file (auto-detect + explicit from config)
    this.identifyRootFile();

    const endTime = Date.now();
    this.metrics.initializationTime = endTime - startTime;

    wsLog.info(
      `Root file: ${this.rootFile || 'none'} (initialized in ${this.metrics.initializationTime}ms)`
    );

    // Warn if initialization was slow
    if (this.metrics.initializationTime > 5000) {
      wsLog.warn(
        `Workspace initialization took ${this.metrics.initializationTime}ms. ` +
        `Consider optimizing your workspace structure or using exclude patterns.`
      );
    }
  }

  /**
   * Initialize with a provided list of files instead of discovering from filesystem.
   * This is primarily useful for testing where files exist only in memory.
   *
   * @param fileUris - List of file URIs that make up the workspace
   * @param parser - Parser instance for parsing documents
   * @param fileReader - Function to read file contents by URI
   * @param _connection - Unused (kept for backward compatibility with test helpers)
   * @param includePathResolver - Optional custom resolver for include paths (for testing)
   */
  async initializeWithFiles(
    fileUris: URI[],
    parser: HledgerParser,
    fileReader: FileReader,
    _connection?: unknown,
    includePathResolver?: IncludePathResolver
  ): Promise<void> {
    const startTime = Date.now();

    this.parser = parser;
    this.fileReader = fileReader;
    this.includePathResolver = includePathResolver;

    // Use provided files directly instead of discovering
    for (const uri of fileUris) {
      this.journalFiles.set(uri.toString(), uri);
    }

    wsLog.log(`Initialized with ${this.journalFiles.size} files`);

    // Build include graph
    await this.buildIncludeGraph();

    // Identify root file
    this.identifyRootFile();

    const endTime = Date.now();
    this.metrics.initializationTime = endTime - startTime;

    wsLog.info(
      `Root file: ${this.rootFile || 'none'} (initialized in ${this.metrics.initializationTime}ms)`
    );
  }

  /**
   * Discover and load configuration from .hledger-lsp.json
   */
  private async loadConfig(runtimeConfig?: Partial<HledgerLspConfig>): Promise<void> {
    wsLog.debug('Loading config');
    if (this.workspaceFolders.length === 0) {
      return;
    }

    // Try to find config file starting from first workspace folder
    const workspaceRoot = this.workspaceFolders[0];
    this.configPath = discoverConfigFile(workspaceRoot, workspaceRoot);
    wsLog.debug(`Config path: ${this.configPath}`);

    if (this.configPath) {
      try {
        const loadResult = loadConfigFile(this.configPath);
        wsLog.debug(`Loaded config: ${JSON.stringify(loadResult.config)}`);

        // Log any warnings
        if (loadResult.warnings.length > 0) {
          wsLog.warn(`Warnings in ${this.configPath}:\n${loadResult.warnings.join('\n')}`);
        }

        // Merge with runtime config (runtime takes precedence)
        this.config = mergeConfig(loadResult.config, runtimeConfig);

        wsLog.log(`Loaded configuration from ${this.configPath}`);
        wsLog.debug(`Effective config: ${JSON.stringify(this.config)}`);
      } catch (error) {
        wsLog.error(`Failed to load config file ${this.configPath}`, error);
        // Continue without config
      }
    }

    // If no config file, just use runtime config with defaults
    if (!this.config) {
      this.config = mergeConfig({}, runtimeConfig);
    }
  }

  /**
   * Discover all .journal and .hledger files in a workspace folder.
   * Uses fast-glob to find files, using patterns from config.
   */
  private async discoverJournalFiles(folder: URI): Promise<URI[]> {
    const folderPath = folder.fsPath;

    // Use patterns from config, or defaults
    const patterns = this.config?.include ?? ['**/*.journal', '**/*.hledger'];
    const ignore = this.config?.exclude ?? ['**/node_modules/**', '**/.git/**'];

    try {
      const entries = await fg(patterns, {
        cwd: folderPath,
        onlyFiles: true,
        absolute: true,
        dot: true,
        ignore
      });

      // Convert to file:// URIs
      const uris = entries.map(p => toFileUri(p));
      uris.sort();

      return uris;
    } catch (error) {
      wsLog.error(`Error discovering journal files in ${folder}`, error);
      return [];
    }
  }

  /**
   * Build the include graph by parsing each discovered file for include directives.
   * This creates both forward (file → includes) and reverse (file → included by) mappings.
   *
   * IMPORTANT: We parse WITHOUT following includes to get only DIRECT includes,
   * not transitive ones. This ensures the graph accurately represents the include structure.
   */
  private async buildIncludeGraph(): Promise<void> {
    this.includeGraph.clear();
    this.reverseGraph.clear();

    for (const fileUri of this.journalFiles.values()) {
      this.updateEdgesFor(fileUri);
    }
  }

  /**
   * (Re)compute the direct include edges of one file, updating both the forward
   * and reverse graphs. Uses the cached parse when present; otherwise reads and
   * parses the file (WITHOUT following includes) and caches the result.
   * Returns true if the file's set of direct includes changed.
   */
  private updateEdgesFor(fileUri: URI): boolean {
    const key = fileUri.toString();
    const previous = this.includeGraph.get(key);
    const includedFiles = new Map<string, URI>();

    let parsed = this.documentCache.get(key);
    if (!parsed) {
      const doc = this.fileReader(fileUri);
      if (doc) {
        parsed = this.parser.parse(doc);
        this.documentCache.set(key, parsed);
      }
    }

    if (!parsed) {
      // Unreadable (possibly transiently): keep whatever edges we already have
      return false;
    }

    // Extract include directives from this file only
    const includeDirectives = parsed.directives.filter(
      (d: Directive) => d.type === 'include' && d.sourceUri?.toString() === key
    );

    // Use injected resolver if available, otherwise default implementation
    const resolver = this.includePathResolver ?? resolveIncludePaths;
    for (const directive of includeDirectives) {
      // Keep only resolved paths that are known workspace files
      for (const resolvedUri of resolver(directive.value, fileUri)) {
        if (this.journalFiles.has(resolvedUri.toString())) {
          includedFiles.set(resolvedUri.toString(), resolvedUri);
        }
      }
    }

    // Drop this file's old reverse edges, then record the new ones
    if (previous) {
      for (const includedString of previous.keys()) {
        this.reverseGraph.get(includedString)?.delete(key);
      }
    }
    this.includeGraph.set(key, includedFiles);
    for (const includedString of includedFiles.keys()) {
      let parents = this.reverseGraph.get(includedString);
      if (!parents) {
        parents = new Map<string, URI>();
        this.reverseGraph.set(includedString, parents);
      }
      parents.set(key, fileUri);
    }

    if (includedFiles.size > 0) {
      wsLog.debug(`${fileUri} directly includes ${includedFiles.size} file(s): ${Array.from(includedFiles.keys()).join(', ')}`);
    }

    const prevKeys = previous ? [...previous.keys()] : [];
    return prevKeys.length !== includedFiles.size || prevKeys.some(k => !includedFiles.has(k));
  }

  /**
   * Identify the single root file using the following algorithm:
   * 1. If explicitly configured in config, use that
   * 2. If autoDetectRoot is enabled, use heuristics to find the best root:
   *    a. Prefer files with NO parents (not included by anyone)
   *    b. Among those, prefer the one that includes the most files
   *    c. If multiple candidates, prefer one with "main" or "all" in the name
   *    d. If still tied, use alphabetically first
   * 3. If no suitable root found, return null (workspace features disabled)
   */
  private identifyRootFile(): void {
    this.rootFile = null;

    // Step 1: Check for explicit root file from config
    if (this.config && this.config.rootFile && this.configPath) {
      const explicitRoot = resolveRootFile(this.config, this.configPath);
      wsLog.log(`Explicit root from config: ${explicitRoot}`);

      if (explicitRoot) {
        wsLog.debug(`Journal files has explicit root: ${this.journalFiles.has(explicitRoot.toString())}`);
        // Verify the file exists and is in our discovered files
        if (this.journalFiles.has(explicitRoot.toString())) {
          this.rootFile = explicitRoot;
          wsLog.log(`Using explicit root from config: ${explicitRoot}`);
          return;
        } else {
          wsLog.warn(`Configured root file not found: ${explicitRoot}`);
        }
      }
    }

    // Step 2: Auto-detect root (if enabled)
    const shouldAutoDetect = this.config?.workspace?.autoDetectRoot ?? true;

    if (!shouldAutoDetect) {
      wsLog.warn('Auto-detect disabled and no valid root configured, workspace features disabled');
      return;
    }

    // Find all files with no parents (not included by anyone)
    const candidateRoots: URI[] = [];
    for (const fileUri of this.journalFiles.values()) {
      const parents = this.reverseGraph.get(fileUri.toString());
      if (!parents || parents.size === 0) {
        candidateRoots.push(fileUri);
        wsLog.debug(`Root candidate (no parents): ${fileUri}`);
      }
    }

    if (candidateRoots.length === 0) {
      wsLog.warn('No root candidates found (all files are included by others), workspace features disabled');
      return;
    }

    if (candidateRoots.length === 1) {
      this.rootFile = candidateRoots[0];
      wsLog.log(`Auto-detected root: ${this.rootFile}`);
      return;
    }

    // Multiple candidates - use heuristics to pick the best one
    wsLog.log(`Multiple root candidates (${candidateRoots.length}), using heuristics to select best`);

    // Score each candidate
    const scores = candidateRoots.map(root => {
      const includeCount = this.includeGraph.get(root.toString())?.size || 0;
      const basename = path.basename(toFilePath(root)).toLowerCase();
      const hasMainInName = basename.includes('main') || basename.includes('all') || basename.includes('index');

      return {
        root,
        includeCount,
        hasMainInName,
        basename
      };
    });

    // Sort by: 1) include count (desc), 2) has "main" in name, 3) alphabetically
    scores.sort((a, b) => {
      if (a.includeCount !== b.includeCount) {
        return b.includeCount - a.includeCount;
      }
      if (a.hasMainInName !== b.hasMainInName) {
        return a.hasMainInName ? -1 : 1;
      }
      return a.basename.localeCompare(b.basename);
    });

    this.rootFile = scores[0].root;
    wsLog.log(
      `Selected root: ${this.rootFile} (includes: ${scores[0].includeCount}, hasMain: ${scores[0].hasMainInName})`
    );
  }

  /**
   * Get the root file for a given file URI.
   * Returns the single root file if it transitively includes this file, or null otherwise.
   *
   * Algorithm:
   * 1. If no root file identified, return null
   * 2. If the root file transitively includes this file (or is the file itself), return the root
   * 3. Otherwise return null (file is not part of the workspace's include graph)
   */
  getRootForFile(uri: URI): URI | null {


    // If workspace hasn't finished initializing yet, return null
    if (!this.rootFile) {
      return null;
    }

    // Check if the root file transitively includes this file
    if (this.rootIncludesFile(this.rootFile, uri)) {
      return this.rootFile;
    }

    // File is not part of the workspace's include graph
    return null;
  }

  /**
   * Check if a root file transitively includes a target file.
   * Uses BFS to traverse the include graph.
   */
  private rootIncludesFile(root: URI, target: URI): boolean {
    if (root.toString() === target.toString()) return true;

    const visited = new Map<string, URI>();
    const queue: URI[] = [root];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.toString())) continue;
      visited.set(current.toString(), current);

      if (current.toString() === target.toString()) return true;

      const includes = this.includeGraph.get(current.toString());
      if (includes) {
        for (const [includedString, included] of includes) {
          if (!visited.has(includedString)) {
            queue.push(included);
          }
        }
      }
    }

    return false;
  }

  /**
   * Get all files that are part of the workspace (transitively included by the root file).
   * Returns an empty array if no root file is identified or workspace is not initialized.
   */
  getAllWorkspaceFiles(): URI[] {
    if (!this.rootFile) {
      return [];
    }

    const files: URI[] = [];
    const visited = new Map<string, URI>();
    const queue: URI[] = [this.rootFile];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.toString())) continue;
      visited.set(current.toString(), current);
      files.push(current);

      const includes = this.includeGraph.get(current.toString());
      if (includes) {
        for (const [includedString, included] of includes) {
          if (!visited.has(includedString)) {
            queue.push(included);
          }
        }
      }
    }

    return files;
  }

  /**
   * Parse the workspace by merging cached documents using the include graph.
   * Returns a cached ParsedDocument if available, otherwise merges and caches.
   *
   * This method uses the document cache populated during buildIncludeGraph(),
   * avoiding redundant parsing. Files are merged in include order using BFS
   * traversal of the include graph.
   *
   * @param force - If true, clears all caches and re-reads files from disk
   */
  parseWorkspace(force: boolean = false): ParsedDocument | null {
    if (!this.rootFile) {
      wsLog.info('No root file — cannot parse workspace');
      return null;
    }

    // Check cache unless force is true
    if (!force && this.workspaceCache) {
      this.metrics.cacheHits++;
      return this.workspaceCache;
    }

    // If force=true, clear the document cache to re-read files from disk
    if (force) {
      this.documentCache.clear();
      wsLog.info('Force flag set, cleared document cache');
    }

    // Cache miss - need to merge from document cache
    this.metrics.cacheMisses++;
    const mergeStartTime = Date.now();

    // Get files in include order
    const orderedFiles = this.getFilesInIncludeOrder();

    // Verify we can read the root file (first in ordered list)
    // This ensures we fail fast if the root file is not accessible
    if (orderedFiles.length > 0) {
      const rootDoc = this.fileReader(orderedFiles[0]);
      if (!rootDoc) {
        throw new Error(`Root file not found: ${this.rootFile}`);
      }
    }

    // Merge all documents in order
    let merged = createEmptyParsedDocument();
    let filesFromCache = 0;
    let filesReparsed = 0;

    for (const uri of orderedFiles) {
      const parsed = this.getCachedDocument(uri);
      if (parsed) {
        merged = mergeParsedDocuments(merged, parsed);
        if (this.documentCache.has(uri.toString())) {
          filesFromCache++;
        } else {
          filesReparsed++;
        }
      } else {
        wsLog.warn(`Could not get document for: ${uri}`);
      }
    }

    const mergeEndTime = Date.now();
    const mergeTime = mergeEndTime - mergeStartTime;
    this.metrics.totalParseTime += mergeTime;
    this.metrics.parseCount++;

    // Log completion
    wsLog.info(
      `Merged ${orderedFiles.length} files in ${mergeTime}ms — ` +
      `${merged.transactions.length} transactions, ${merged.accounts.size} accounts ` +
      `(${filesFromCache} cached, ${filesReparsed} re-parsed)`
    );

    // Warn on slow operations
    if (mergeTime > 1000) {
      wsLog.warn(`Slow parse detected: ${this.rootFile} took ${mergeTime}ms`);
    }

    // Cache the result
    this.workspaceCache = merged;

    return merged;
  }

  /**
   * Parse from a specific file, treating it as the root.
   * This traverses the include graph starting from the given file and merges
   * all reachable documents.
   *
   * Use this when:
   * - No workspace root has been identified
   * - You want to parse a specific file with its includes
   * - The file may not be part of the main workspace include tree
   *
   * Note: This does NOT use the workspace cache. Each call merges fresh from
   * the document cache. For files that are part of the workspace tree, prefer
   * parseWorkspace() which uses caching.
   *
   * @param uri - The file to start parsing from (treated as root)
   * @returns Merged ParsedDocument containing the file and all its includes
   */
  parseFromFile(uri: URI): ParsedDocument {
    const mergeStartTime = Date.now();

    // Get files in include order starting from this file
    const orderedFiles = this.getFilesInIncludeOrderFrom(uri);

    // If the file isn't in our known files, parse it directly
    if (orderedFiles.length === 0) {
      const doc = this.fileReader(uri);
      if (!doc) {
        wsLog.warn(`Could not read file: ${uri}`);
        return createEmptyParsedDocument();
      }
      // Parse in document mode (single file, no includes)
      return this.parser.parse(doc);
    }

    // Merge all documents in order
    let merged = createEmptyParsedDocument();

    for (const fileUri of orderedFiles) {
      let parsed = this.getCachedDocument(fileUri);
      if (!parsed) {
        // File not in journalFiles (e.g., dotfile excluded from discovery)
        // Fall back to reading and parsing directly
        const doc = this.fileReader(fileUri);
        if (doc) {
          parsed = this.parser.parse(doc);
          wsLog.info(`Parsed file directly (not in workspace files): ${fileUri}`);
        } else {
          wsLog.warn(`Could not get document for: ${fileUri}`);
        }
      }
      if (parsed) {
        merged = mergeParsedDocuments(merged, parsed);
      }
    }

    const mergeEndTime = Date.now();
    const mergeTime = mergeEndTime - mergeStartTime;

    wsLog.info(
      `Merged ${orderedFiles.length} file(s) from ${uri} in ${mergeTime}ms — ` +
      `${merged.transactions.length} transactions, ${merged.accounts.size} accounts`
    );

    return merged;
  }

  /**
   * Invalidate the cache for a file.
   * Clears the workspace cache if the root file transitively includes this file.
   * Also clears the per-file document cache entry for re-parsing on next access.
   */
  invalidateFile(uri: URI): void {
    const uriString = uri.toString();
    const wasInWorkspace = !!this.rootFile && this.rootIncludesFile(this.rootFile, uri);

    // Clear the per-file document cache entry
    if (this.documentCache.has(uriString)) {
      this.documentCache.delete(uriString);
      wsLog.info(`Cleared document cache for: ${uri}`);
    }

    // The file's include lines may have changed: refresh its edges (re-parses it)
    let edgesChanged = false;
    if (this.journalFiles.has(uriString)) {
      edgesChanged = this.updateEdgesFor(uri);
      if (edgesChanged) {
        wsLog.info(`Include edges changed for: ${uri}`);
        this.identifyRootFile();
      }
    }

    // If the workspace includes (or included) this file, clear the workspace cache
    const isInWorkspace = !!this.rootFile && this.rootIncludesFile(this.rootFile, uri);
    if (wasInWorkspace || isInWorkspace || edgesChanged) {
      wsLog.info(`Invalidating workspace cache due to change in: ${uri}`);
      this.workspaceCache = null;
    } else {
      wsLog.info(`File change doesn't affect workspace cache: ${uri}`);
    }
  }

  /**
   * Apply file-system changes reported by the client (workspace/didChangeWatchedFiles),
   * typically for files not open in the editor. Created files are admitted only if they
   * match the workspace's include/exclude patterns; deleted files leave the workspace.
   * The include graph and root are refreshed and the workspace cache is cleared.
   */
  async applyFileChanges(changes: Array<{ uri: URI; type: 'created' | 'changed' | 'deleted' }>): Promise<void> {
    let membershipChanged = false;

    for (const { uri, type } of changes) {
      this.documentCache.delete(uri.toString());
      if (type === 'deleted' && this.journalFiles.delete(uri.toString())) {
        membershipChanged = true;
      }
    }

    const created = changes.filter(c => c.type === 'created' && !this.journalFiles.has(c.uri.toString()));
    if (created.length > 0) {
      const before = this.journalFiles.size;
      if (this.workspaceFolders.length > 0) {
        // Re-discover so include/exclude patterns from config are honoured
        for (const folder of this.workspaceFolders) {
          for (const file of await this.discoverJournalFiles(folder)) {
            this.journalFiles.set(file.toString(), file);
          }
        }
      } else {
        // Workspace built from an explicit file list: admit created files directly
        for (const { uri } of created) {
          this.journalFiles.set(uri.toString(), uri);
        }
      }
      membershipChanged = membershipChanged || this.journalFiles.size !== before;
    }

    if (membershipChanged) {
      // Other files' include globs may now match (or no longer match) these files
      await this.buildIncludeGraph();
    } else {
      for (const { uri } of changes) {
        if (this.journalFiles.has(uri.toString())) {
          this.updateEdgesFor(uri);
        }
      }
    }

    this.identifyRootFile();
    this.workspaceCache = null;
    wsLog.info(`Applied ${changes.length} watched-file change(s); workspace cache cleared`);
  }

  /**
   * Glob patterns (relative to each workspace folder) the client should watch
   * so that out-of-editor changes reach applyFileChanges().
   */
  getWatchPatterns(): string[] {
    return this.config?.include ?? ['**/*.journal', '**/*.hledger'];
  }

  /**
   * Get a cached ParsedDocument for a file.
   * If the document is not in cache (e.g., after invalidation), it will be re-parsed.
   * Returns null if the file cannot be read or is not part of the workspace.
   */
  getCachedDocument(uri: URI): ParsedDocument | null {
    const uriString = uri.toString();

    // Check if already cached
    const cached = this.documentCache.get(uriString);
    if (cached) {
      return cached;
    }

    // Not in cache - try to re-parse if it's a known journal file
    if (!this.journalFiles.has(uriString)) {
      return null;
    }

    const doc = this.fileReader(uri);
    if (!doc) {
      return null;
    }

    const parsed = this.parser.parse(doc);

    // Store in cache
    this.documentCache.set(uriString, parsed);
    wsLog.info(`Re-parsed and cached: ${uri}`);

    return parsed;
  }

  /**
   * Check if a document is currently cached.
   */
  hasDocumentCached(uri: URI): boolean {
    return this.documentCache.has(uri.toString());
  }

  /**
   * Get the number of cached documents.
   * Useful for diagnostics and testing.
   */
  getDocumentCacheSize(): number {
    return this.documentCache.size;
  }

  /**
   * Get the include graph for debugging/testing.
   * Returns a map where keys are file URIs and values are arrays of included file URIs.
   */
  getIncludeGraph(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [fileUri, includes] of this.includeGraph) {
      result.set(fileUri, Array.from(includes.values()).map(uri => uri.toString()));
    }
    return result;
  }

  /**
   * Get the reverse include graph for debugging/testing.
   * Returns a map where keys are file URIs and values are arrays of URIs of files that include them.
   */
  getReverseIncludeGraph(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [fileUri, parents] of this.reverseGraph) {
      result.set(fileUri, Array.from(parents.values()).map(uri => uri.toString()));
    }
    return result;
  }

  /**
   * Get files that directly include the given file.
   * Returns URIs of parent files from the reverse include graph.
   */
  getFilesIncluding(fileUri: URI): URI[] {
    const parents = this.reverseGraph.get(fileUri.toString());
    if (!parents) return [];
    return Array.from(parents.values());
  }

  /**
   * Get include directives from a file with their resolved target URIs.
   * Returns the directive and the URIs it resolves to (may be multiple for glob includes).
   */
  getIncludeDirectivesForFile(fileUri: URI): Array<{ directive: Directive; targets: URI[] }> {
    const parsed = this.documentCache.get(fileUri.toString());
    if (!parsed) return [];

    const includeDirectives = parsed.directives.filter(
      (d: Directive) => d.type === 'include' && d.sourceUri?.toString() === fileUri.toString()
    );

    const result: Array<{ directive: Directive; targets: URI[] }> = [];

    for (const directive of includeDirectives) {
      const resolver = this.includePathResolver ?? resolveIncludePaths;
      const resolvedPaths = resolver(directive.value, fileUri);

      // Filter to known workspace files
      const targets = resolvedPaths.filter(uri => this.journalFiles.has(uri.toString()));
      result.push({ directive, targets });
    }

    return result;
  }

  /**
   * Check if a URI is a known file in the workspace.
   */
  isKnownFile(fileUri: URI): boolean {
    return this.journalFiles.has(fileUri.toString());
  }

  /**
   * Get all files in include order using BFS traversal from the workspace root.
   * This returns files in the order they should be merged to produce
   * the same result as recursive include processing.
   */
  private getFilesInIncludeOrder(): URI[] {
    if (!this.rootFile) {
      return [];
    }
    return this.getFilesInIncludeOrderFrom(this.rootFile);
  }

  /**
   * Get all files in include order using BFS traversal from a given starting file.
   * This returns files in the order they should be merged to produce
   * the same result as recursive include processing.
   *
   * @param startUri - The file to start traversal from (treated as root)
   */
  private getFilesInIncludeOrderFrom(startUri: URI): URI[] {
    const result: URI[] = [];
    const visited = new Set<string>();
    const queue: URI[] = [startUri];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentString = current.toString();

      if (visited.has(currentString)) {
        continue;
      }
      visited.add(currentString);
      result.push(current);

      // Get files included by current file (in order)
      const includes = this.includeGraph.get(currentString);
      if (includes) {
        for (const [, includedUri] of includes) {
          if (!visited.has(includedUri.toString())) {
            queue.push(includedUri);
          }
        }
      }
    }

    return result;
  }

  /**
   * Get diagnostic information about the workspace.
   * Useful for troubleshooting and performance monitoring.
   */
  getDiagnosticInfo(): {
    totalFiles: number;
    rootFile: URI | null;
    cached: boolean;
    documentsCached: number;
    configFile: URI | null;
    performance: {
      initializationTime: number;
      cacheHits: number;
      cacheMisses: number;
      cacheHitRate: string;
      averageParseTime: number;
      totalParseTime: number;
      parseCount: number;
    };
  } {
    const totalAccesses = this.metrics.cacheHits + this.metrics.cacheMisses;
    const cacheHitRate = totalAccesses > 0
      ? ((this.metrics.cacheHits / totalAccesses) * 100).toFixed(1) + '%'
      : 'N/A';
    const avgParseTime = this.metrics.parseCount > 0
      ? Math.round(this.metrics.totalParseTime / this.metrics.parseCount)
      : 0;

    return {
      totalFiles: this.journalFiles.size,
      rootFile: this.rootFile,
      cached: this.workspaceCache !== null,
      documentsCached: this.documentCache.size,
      configFile: this.configPath,
      performance: {
        initializationTime: this.metrics.initializationTime,
        cacheHits: this.metrics.cacheHits,
        cacheMisses: this.metrics.cacheMisses,
        cacheHitRate,
        averageParseTime: avgParseTime,
        totalParseTime: this.metrics.totalParseTime,
        parseCount: this.metrics.parseCount
      }
    };
  }

  /**
   * Log diagnostic information to the console.
   * Useful for debugging and performance analysis.
   */
  logDiagnostics(): void {
    const info = this.getDiagnosticInfo();
    wsLog.log('=== WorkspaceManager Diagnostics ===');
    wsLog.log(`Files: ${info.totalFiles} total`);
    wsLog.log(`Root: ${info.rootFile || 'none'}`);
    wsLog.log(`Workspace cache: ${info.cached ? 'populated' : 'empty'}`);
    wsLog.log(`Document cache: ${info.documentsCached} files`);
    wsLog.log(`Config: ${info.configFile || 'none'}`);
    wsLog.log('Performance:');
    wsLog.log(`  Initialization: ${info.performance.initializationTime}ms`);
    wsLog.log(`  Cache hits: ${info.performance.cacheHits}`);
    wsLog.log(`  Cache misses: ${info.performance.cacheMisses}`);
    wsLog.log(`  Cache hit rate: ${info.performance.cacheHitRate}`);
    wsLog.log(`  Parses: ${info.performance.parseCount} (avg ${info.performance.averageParseTime}ms)`);
    wsLog.log(`  Total parse time: ${info.performance.totalParseTime}ms`);
    wsLog.log('===================================');
  }
  /**
   * Generate a text-based tree representation of the workspace.
   */
  getWorkspaceTree(): string {
    if (!this.rootFile) {
      return 'No root file identified';
    }

    const lines: string[] = [];
    lines.push(path.basename(toFilePath(this.rootFile)));
    this.printTree(this.rootFile, '', lines, new Set([this.rootFile]));

    return lines.join('\n');
  }

  /**
   * Generate a structured representation of the workspace for better tooling integration.
   * Returns an array of entries with display text and absolute file paths.
   */
  getWorkspaceTreeStructured(): Array<{ display: string; path: string; uri: URI }> {
    if (!this.rootFile) {
      return [];
    }

    const entries: Array<{ display: string; path: string; uri: URI }> = [];
    const rootPath = toFilePath(this.rootFile);
    entries.push({
      display: path.basename(rootPath),
      path: rootPath,
      uri: this.rootFile
    });
    this.collectTreeEntries(this.rootFile, '', entries, new Set([this.rootFile]));

    return entries;
  }

  private collectTreeEntries(
    uri: URI,
    prefix: string,
    entries: Array<{ display: string; path: string; uri: URI }>,
    visited: Set<URI>
  ): void {
    const includes = this.includeGraph.get(uri.toString());
    if (!includes || includes.size === 0) return;

    const children = Array.from(includes).sort();
    const parentPath = toFilePath(uri);
    const parentDir = path.dirname(parentPath);

    for (let i = 0; i < children.length; i++) {
      const child = children[i][1];
      const isLast = i === children.length - 1;
      const marker = isLast ? '└── ' : '├── ';

      const childPath = toFilePath(child);
      const displayPath = path.relative(parentDir, childPath);

      entries.push({
        display: `${prefix}${marker}${displayPath}`,
        path: childPath,
        uri: child
      });

      if (!visited.has(child)) {
        const newPrefix = prefix + (isLast ? '    ' : '│   ');
        this.collectTreeEntries(child, newPrefix, entries, new Set([...visited, child]));
      } else {
        entries.push({
          display: `${prefix}${isLast ? '    ' : '│   '}└── (cycle)`,
          path: '',
          uri: URI.parse('')
        });
      }
    }
  }

  private printTree(uri: URI, prefix: string, lines: string[], visited: Set<URI>): void {
    const includes = this.includeGraph.get(uri.toString());
    if (!includes || includes.size === 0) return;

    const children = Array.from(includes).sort();
    const parentPath = toFilePath(uri);
    const parentDir = path.dirname(parentPath);

    for (let i = 0; i < children.length; i++) {
      const child = children[i][1];
      const isLast = i === children.length - 1;
      const marker = isLast ? '└── ' : '├── ';

      const childPath = toFilePath(child);
      let displayPath = path.relative(parentDir, childPath);

      lines.push(`${prefix}${marker}${displayPath}`);

      if (!visited.has(child)) {
        const newPrefix = prefix + (isLast ? '    ' : '│   ');
        this.printTree(child, newPrefix, lines, new Set([...visited, child]));
      } else {
        lines.push(`${prefix}${isLast ? '    ' : '│   '}└── (cycle)`);
      }
    }
  }
}
