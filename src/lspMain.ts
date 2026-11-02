import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  Disposable,
} from 'vscode-languageserver/node';

import { URI } from 'vscode-uri';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { registerLanguageFeatures } from './server/featureRegistry';
import { tokenTypes, tokenModifiers } from './features/semanticTokens';
import { validator } from './features/validator';
import { HledgerParser } from './parser/index';
import { HledgerSettings, defaultSettings, getDocumentSettings as getDocumentSettingsModule, clearDocumentSettings, clearAllDocumentSettings } from './server/settings';
import { defaultFileReader, resolveIncludePath as resolveIncludePathUtil, toFileUri } from './utils/uri';
import { updateDependencies, clearDependencies, getDependents } from './server/deps';
import { WorkspaceManager } from './server/workspace';
import { buildFileWatchers, toJournalFileChanges, CONFIG_FILE_NAME } from './server/fileWatchers';
import { parseWithWorkspace } from './server/documentParse';
import * as path from 'path';
import { FileReader } from './types';
import { completionProvider } from './features/completion';
import { logger } from './utils/logger';

// Create a connection for the server using Node's IPC as a transport
const connection = createConnection(ProposedFeatures.all);

// Initialise the global logger as early as possible so all modules can use it.
logger.init(connection.console);

const serverLog = logger.withContext('Server');

logger.log('*========= HLEDGER LSP SERVER STARTING ==========');
// Diagnostic: print runtime filename and argv to verify which file is loaded by the EDH
try {
  // __filename points at the compiled JS file when running under Node
  serverLog.debug(`__filename: ${__filename}`);
  serverLog.debug(`process.argv: ${process.argv.join(' ')}`);
} catch (e) {
  // ignore in environments where __filename isn't available
}

// Create a simple text document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasDidChangeConfigurationDynamicRegistration = false;
let hasInlayHintRefreshSupport = false;
let hasCodeLensRefreshSupport = false;
let hasWatchedFilesDynamicRegistration = false;
let hasWatchedFilesRelativePatternSupport = false;
let watchedFilesRegistration: Promise<Disposable> | null = null;

// Workspace state
let workspaceFolders: URI[] = [];
let workspaceManager: WorkspaceManager | null = null;

connection.onInitialize((params: InitializeParams) => {
  serverLog.log('onInitialize called');
  serverLog.debug(`workspaceFolders: ${JSON.stringify(params.workspaceFolders)}`);

  // Get version from package.json
  let version = 'unknown';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const packageJson = require('../package.json');
    version = packageJson.version;
  } catch (error) {
    serverLog.warn('Failed to read version from package.json');
  }

  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  // Check if client supports dynamic registration for didChangeConfiguration
  hasDidChangeConfigurationDynamicRegistration = !!(
    capabilities.workspace &&
    capabilities.workspace.didChangeConfiguration &&
    capabilities.workspace.didChangeConfiguration.dynamicRegistration
  );

  // Check if client supports inlay hint refresh
  hasInlayHintRefreshSupport = !!(
    capabilities.workspace &&
    capabilities.workspace.inlayHint &&
    capabilities.workspace.inlayHint.refreshSupport
  );

  hasCodeLensRefreshSupport = !!(
    capabilities.workspace &&
    capabilities.workspace.codeLens &&
    capabilities.workspace.codeLens.refreshSupport
  );

  hasWatchedFilesDynamicRegistration = !!capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
  hasWatchedFilesRelativePatternSupport = !!capabilities.workspace?.didChangeWatchedFiles?.relativePatternSupport;

  serverLog.debug(`Watched files dynamic registration: ${hasWatchedFilesDynamicRegistration} (relative patterns: ${hasWatchedFilesRelativePatternSupport})`);
  serverLog.debug(`Inlay hint refresh support: ${hasInlayHintRefreshSupport}`);
  serverLog.debug(`Code lens refresh support: ${hasCodeLensRefreshSupport}`);
  serverLog.debug(`Dynamic registration for didChangeConfiguration: ${hasDidChangeConfigurationDynamicRegistration}`);
  serverLog.debug(`Configuration capability: ${hasConfigurationCapability}`);

  // Store workspace folders
  if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    workspaceFolders = params.workspaceFolders.map(folder => URI.parse(folder.uri));
  } else {
    // Fallback for clients that don't support workspaceFolders
    // rootUri is deprecated but kept for backward compatibility
    const legacyRootUri = params.rootUri;
    if (legacyRootUri) {
      workspaceFolders = [URI.parse(legacyRootUri)];
    }
  }

  const result: InitializeResult = {
    serverInfo: {
      name: 'hledger-lsp',
      version: version
    },
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: [':', ' ']
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      codeActionProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentOnTypeFormattingProvider: {
        firstTriggerCharacter: '\n',
      },
      semanticTokensProvider: {
        legend: {
          tokenTypes: tokenTypes,
          tokenModifiers: tokenModifiers
        },
        full: true
      },
      inlayHintProvider: true,
      codeLensProvider: {
        resolveProvider: false
      },
      renameProvider: {
        prepareProvider: true
      },
      foldingRangeProvider: true,
      documentLinkProvider: {
        resolveProvider: false
      },
      selectionRangeProvider: true,
      callHierarchyProvider: true,
      executeCommandProvider: {
        commands: [
          'hledger.addBalanceAssertion',
          'hledger.insertBalanceAssertion',
          'hledger.insertInferredAmount',
          'hledger.convertToTotalCost',
          'hledger.refreshInlayHints',
          'hledger.showWorkspaceGraphStructured'
        ]
      }
    }
  };

  serverLog.log(`onInitialize complete — version ${version}, ${workspaceFolders.length} workspace folder(s)`);

  return result;
});

connection.onInitialized(async () => {
  serverLog.log('onInitialized called');

  // Only use dynamic registration if the client supports it
  if (hasConfigurationCapability && hasDidChangeConfigurationDynamicRegistration) {
    // Register for all configuration changes dynamically
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined
    );
  }

  // Initialize WorkspaceManager if we have workspace folders
  if (workspaceFolders.length > 0) {
    // File watchers are registered by initializeWorkspaceManager once the
    // include patterns from .hledger-lsp.json are known (issue #31).
    await initializeWorkspaceManager(workspaceFolders);
  } else {
    serverLog.log('No workspace folders — WorkspaceManager will be initialized when first document is opened');
  }
});

/**
 * Ask the client to watch journal files and the config file, so that changes made
 * outside the editor reach onDidChangeWatchedFiles. Re-registers (replacing the old
 * watchers) when the include patterns may have changed, e.g. after a config reload.
 */
async function registerFileWatchers(folders: URI[], patterns: string[]): Promise<void> {
  if (!hasWatchedFilesDynamicRegistration) {
    serverLog.debug('Client lacks dynamic didChangeWatchedFiles registration — relying on client-side watchers');
    return;
  }

  try {
    if (watchedFilesRegistration) {
      const previous = watchedFilesRegistration;
      watchedFilesRegistration = null;
      (await previous).dispose();
    }
    const watchers = buildFileWatchers(folders, patterns, hasWatchedFilesRelativePatternSupport);
    watchedFilesRegistration = connection.client.register(DidChangeWatchedFilesNotification.type, { watchers });
    await watchedFilesRegistration;
    serverLog.log(`Registered ${watchers.length} file watcher(s)`);
  } catch (error) {
    watchedFilesRegistration = null;
    serverLog.warn(`Failed to register file watchers: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Helper function to initialize workspace manager
async function initializeWorkspaceManager(folders: URI[], forceReinit: boolean = false): Promise<void> {
  if (workspaceManager && !forceReinit) {
    serverLog.debug('WorkspaceManager already initialized, skipping');
    return;
  }

  // Get workspace settings to pass as runtime config
  const settings = await getDocumentSettings(folders[0]);
  const runtimeConfig = settings?.workspace ? {
    workspace: settings.workspace
  } : undefined;

  workspaceManager = new WorkspaceManager();
  try {
    serverLog.log(`Initializing WorkspaceManager with folders: ${folders.join(', ')}`);
    await workspaceManager.initialize(
      folders,
      sharedParser,
      fileReader,
      connection,
      runtimeConfig
    );

    // Log the root file being used
    const diagnostics = workspaceManager.getDiagnosticInfo();
    if (diagnostics.rootFile) {
      serverLog.info(`Workspace root file: ${diagnostics.rootFile}`);
    } else {
      serverLog.warn('No workspace root file detected — workspace features disabled');
    }

    serverLog.log('WorkspaceManager initialized');

    await registerFileWatchers(folders, workspaceManager.getWatchPatterns());

    // Refresh all open documents now that workspace context is available
    const openDocuments = documents.all();
    for (const doc of openDocuments) {
      await validateTextDocument(doc, 'workspace-init');
    }

    serverLog.log(`Refreshed ${openDocuments.length} open document(s) with workspace context`);
  } catch (error) {
    logger.error('Failed to initialize WorkspaceManager', error);
    connection.window.showErrorMessage(
      `hledger-lsp: workspace initialization failed — ${error instanceof Error ? error.message : String(error)}`
    );
    workspaceManager = null;
  }
}

// Global settings used when client does not support workspace/configuration
let globalSettings: HledgerSettings = defaultSettings;


// Create a shared parser instance with caching
const sharedParser = new HledgerParser();

// Small helper to centralize parsing options and reduce duplication across handlers
function parseDocument(
  document: TextDocument
) {
  // Shared with `hledger-lsp --format` so the CLI resolves a document to the same
  // parse the editor sees (see documentParse.ts)
  return parseWithWorkspace(document, workspaceManager, sharedParser);
}

connection.onDidChangeConfiguration(change => {
  if (hasConfigurationCapability) {
    clearAllDocumentSettings();
    serverLog.debug('Configuration changed — settings cache cleared');
  } else {
    globalSettings = <HledgerSettings>(
      (change.settings.hledgerLanguageServer || defaultSettings)
    );
    serverLog.debug('Configuration changed (legacy) — global settings updated');
  }

  // Revalidate all open text documents
  documents.all().forEach(doc => validateTextDocument(doc, 'config-change'));
});

// Wrapper around settings module to use connection and capability flag
function getDocumentSettings(resource: URI): Thenable<HledgerSettings> {
  return getDocumentSettingsModule(connection, resource, hasConfigurationCapability);
}


// Lazy initialize workspace manager when first document is opened
documents.onDidOpen(async e => {
  serverLog.log(`Document opened: ${e.document.uri}`);

  // If workspace manager not initialized and we don't have workspace folders,
  // use the directory of the opened document as the workspace
  if (!workspaceManager && workspaceFolders.length === 0) {
    const uri: URI = URI.parse(e.document.uri);
    const filePath = uri.fsPath;
    const dirPath = path.dirname(filePath);
    const workspaceUri = toFileUri(dirPath);

    serverLog.log(`Lazy-initializing WorkspaceManager with directory: ${workspaceUri}`);
    await initializeWorkspaceManager([workspaceUri]);
  }

  // Validate the newly opened document
  await validateTextDocument(e.document, 'document-open');
});

// Only keep settings for open documents
documents.onDidClose(e => {
  clearDocumentSettings(URI.parse(e.document.uri));
  clearDependencies(URI.parse(e.document.uri));
});

// The content of a text document has changed
documents.onDidChangeContent(change => {
  serverLog.debug(`Document changed: ${change.document.uri} (version ${change.document.version})`);


  // Invalidate workspace cache for affected roots
  if (workspaceManager) {
    workspaceManager.invalidateFile(URI.parse(change.document.uri));
  }

  validateTextDocument(change.document, 'document-change');

  // Re-validate all files that depend on this one
  const dependents = getDependents(URI.parse(change.document.uri));
  if (dependents) {
    for (const dependentUri of dependents) {
      const dependentDoc = getDocument(dependentUri.toString());
      if (dependentDoc) {
        validateTextDocument(dependentDoc, 'dependent-change');
      }
    }
  }

  // Refresh inlay hints after any document change
  // This ensures positions update correctly when lines are added/removed
  // and that workspace-wide state (running balances, etc.) stays in sync
  if (hasInlayHintRefreshSupport) {
    connection.languages.inlayHint.refresh();
  }

  // In workspace mode, changes to one file affect all files in the workspace
  // (e.g., running balances, transaction counts, completions)
  // Re-validate other open documents that share the same root
  if (workspaceManager) {
    const changedRoot = workspaceManager.getRootForFile(URI.parse(change.document.uri));

    if (changedRoot) {
      // Find all open documents that share the same root (excluding the current one, which was already validated)
      const allDocs = documents.all();

      const affectedDocs = allDocs.filter(doc => {
        const docRoot = workspaceManager!.getRootForFile(URI.parse(doc.uri));
        const isSameRoot = docRoot === changedRoot;
        // Normalize URIs for comparison to handle encoding differences
        const isDifferentFile = URI.parse(doc.uri).toString() !== URI.parse(change.document.uri).toString();
        return isSameRoot && isDifferentFile;
      });

      // Re-validate affected documents (updates diagnostics)
      if (affectedDocs.length > 0) {
        serverLog.debug(`Cascade revalidation: ${affectedDocs.length} affected document(s)`);
        for (const doc of affectedDocs) {
          validateTextDocument(doc, 'cascade');
        }
      }

      // Note: Inlay hints refresh above already covers all documents
      // Code lenses will refresh when the client next requests them
      // We've already invalidated the workspace cache above, which is sufficient
    }
  }
});

// Watch for config file (.hledger-lsp.json) and journal file changes made outside the editor
connection.onDidChangeWatchedFiles(async (params) => {
  // A config change rebuilds the whole workspace, which also covers any journal changes
  const configChange = params.changes.find(change => change.uri.endsWith(CONFIG_FILE_NAME));
  if (configChange) {
    serverLog.log(`Config file changed: ${configChange.uri} — reinitializing workspace`);

    // Reinitialize workspace manager with new config (revalidates open documents)
    if (workspaceFolders.length > 0) {
      await initializeWorkspaceManager(workspaceFolders, true);
    }
    return;
  }

  if (!workspaceManager) return;

  const journalChanges = toJournalFileChanges(params.changes, uri => !!getDocument(uri));
  if (journalChanges.length === 0) return;

  serverLog.log(`Watched journal file change(s): ${journalChanges.map(c => `${c.type} ${c.uri}`).join(', ')}`);
  await workspaceManager.applyFileChanges(journalChanges);

  // Any open document may depend on the changed files through the workspace
  for (const doc of documents.all()) {
    validateTextDocument(doc, 'watched-file-change');
  }
  if (hasInlayHintRefreshSupport) {
    connection.languages.inlayHint.refresh();
  }
});

// dependency tracking moved to src/server/deps.ts

/**
 * Helper function to get a document from the collection with fuzzy URI matching
 * Handles differences in URI encoding between VSCode and Neovim
 */
function getDocument(uri: string): TextDocument | undefined {
  // Try 1: Exact match
  let doc = documents.get(uri);
  if (doc) return doc;

  // Try 2: Normalized URI
  const normalized = URI.parse(uri).toString();
  if (normalized !== uri) {
    doc = documents.get(normalized);
    if (doc) return doc;
  }

  // Try 3: Search all documents with normalized comparison
  for (const openDoc of documents.all()) {
    if (URI.parse(openDoc.uri).toString() === normalized) {
      return openDoc;
    }
  }

  return undefined;
}

// Create a file reader that uses in-memory documents when available
// This ensures we see unsaved changes in the editor
const fileReader: FileReader = (uri: URI) => {
  const uriString = uri.toString();

  // Try to find the document with fuzzy URI matching
  const openDoc = getDocument(uriString);
  if (openDoc) {
    return openDoc;
  }
  return defaultFileReader(uri);
};

async function validateTextDocument(textDocument: TextDocument, reason = 'unknown'): Promise<void> {
  serverLog.debug(`Validating ${textDocument.uri} [${reason}]`);
  // Get document settings
  const settings = (await getDocumentSettings(URI.parse(textDocument.uri))) ?? defaultSettings;

  // Validation needs workspace state for balance assertions and full transaction history
  const parsedDoc = parseDocument(textDocument);
  // Track which files this document includes
  const includedFiles = new Set<URI>();
  for (const directive of parsedDoc.directives) {
    if (directive.type === 'include') {
      const resolvedPath = resolveIncludePathUtil(directive.value, URI.parse(textDocument.uri));
      includedFiles.add(resolvedPath);
    }
  }
  updateDependencies(URI.parse(textDocument.uri), includedFiles);

  // Update completion data from the parsed document (includes all workspace files)
  completionProvider.updateAccounts(parsedDoc.accounts);
  completionProvider.updatePayees(parsedDoc.payees);
  completionProvider.updateCommodities(parsedDoc.commodities);
  completionProvider.updateTags(parsedDoc.tags);

  // Validate the document with settings
  const validationResult = validator.validate(textDocument, parsedDoc, {
    baseUri: URI.parse(textDocument.uri),
    fileReader,
    settings: {
      validation: settings?.validation,
      severity: settings?.severity
    }
  }, reason);

  // Send diagnostics to the client
  connection.sendDiagnostics({
    uri: textDocument.uri,
    diagnostics: validationResult.diagnostics
  });
}

// include path resolution moved to src/utils/uri.ts

// Ensure the feature registry bindings are created
registerLanguageFeatures({
  connection,
  documents,
  getWorkspaceManager: () => workspaceManager,
  sharedParser,
  fileReader,
  hasConfigurationCapability,
  hasInlayHintRefreshSupport,
  getDocument,
  parseDocument,
  getDocumentSettings
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();

logger.log('hledger-lsp awaiting LSP connection');
