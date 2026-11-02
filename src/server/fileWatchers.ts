// Helpers for workspace/didChangeWatchedFiles: which globs to ask the client to
// watch, and how to turn its events into WorkspaceManager.applyFileChanges input.

import { URI } from 'vscode-uri';
import { FileChangeType, FileEvent, FileSystemWatcher } from 'vscode-languageserver/node';

export const CONFIG_FILE_NAME = '.hledger-lsp.json';

export interface JournalFileChange {
  uri: URI;
  type: 'created' | 'changed' | 'deleted';
}

/**
 * Build watchers for the workspace's journal include patterns plus the config file.
 * Patterns are relative to each workspace folder; clients without relative-pattern
 * support get plain globs, with non-`**` patterns anchored by a leading `**`.
 */
export function buildFileWatchers(
  folders: URI[],
  patterns: string[],
  relativePatternSupport: boolean
): FileSystemWatcher[] {
  const all = [...patterns, `**/${CONFIG_FILE_NAME}`];

  if (relativePatternSupport && folders.length > 0) {
    return folders.flatMap(folder =>
      all.map(pattern => ({ globPattern: { baseUri: folder.toString(), pattern } }))
    );
  }

  return all.map(pattern => ({
    globPattern: pattern.startsWith('**/') ? pattern : `**/${pattern}`,
  }));
}

/**
 * Convert client file events into journal changes. Config-file events are dropped
 * (handled separately), and "changed" events for open documents are ignored because
 * the in-memory version wins and is already handled via didChange.
 */
export function toJournalFileChanges(
  events: FileEvent[],
  isOpen: (uri: string) => boolean
): JournalFileChange[] {
  const result: JournalFileChange[] = [];
  for (const event of events) {
    if (event.uri.endsWith(CONFIG_FILE_NAME)) continue;
    if (event.type === FileChangeType.Changed && isOpen(event.uri)) continue;

    const type =
      event.type === FileChangeType.Created ? 'created'
        : event.type === FileChangeType.Deleted ? 'deleted'
          : 'changed';
    result.push({ uri: URI.parse(event.uri), type });
  }
  return result;
}
