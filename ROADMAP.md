# Roadmap

## In flight

- **Release 0.8.0** (#31 fix): the version commit and the `v0.8.0` tag exist
  locally. Pushing the tag runs the CI publish job.
- **#31 follow-ups in the client repos** (separate sessions):
  - hledger-vscode: drop the stale `.clientrc` watcher; bump to `^0.8.0` once it's
    on npm (the Dependabot cooldown delays automatic bumps).
  - hledger-nvim: verify that Neovim advertises dynamic watched-file registration
    on each platform (likely off on Linux), check end to end, and document it in
    the README.

## Next

- **assertions-18.j**, the last corpus false positive. It's blocked on the
  one-`Amount`-per-posting model: hledger infers two amounts for one amount-less
  posting. Needs a data-model change.
- **Missed errors (~20 in the corpus report).** Add error *detection* to the
  parser: it records problems for the validator, and never fails.
- **Extend the fuzz grammar.** Each new construct is a new class under test; a
  clean run on the current grammar finds nothing new.

## Notes / TODO

- Clients without dynamic `didChangeWatchedFiles` registration still go stale on
  external edits to unopened included files. A fallback could re-check mtimes of
  cached files when validating. Low priority: Neovim 0.10+ and VS Code both
  support registration.
- Config-file reload (`.hledger-lsp.json`) only runs when the client sent
  workspace folders. A lazily initialized workspace (first opened document) never
  reloads its config.
- Deferred dependency majors: TypeScript 7 (typescript-eslint peers <6.1).
- Exact-decimal (BigInt) parsing for commodities with more than 10 decimal places.

## Completed

- #31: external changes to unopened journal files (edit / create / delete) now
  refresh the workspace. Watchers are registered dynamically, and the include
  graph follows edits.
- Differential fuzzing harness against hledger (`tests/fuzz`, `npm run fuzz`).
- Corpus agreement raised to 92% (ratchet 0.92) through divergence clusters 1–5,
  smart dates, and validator gaps.
- Formatter corruption fixes (year-less dates, virtual-posting delimiters), 0.6.4.
- CI publishes to npm via trusted publishing (OIDC).
