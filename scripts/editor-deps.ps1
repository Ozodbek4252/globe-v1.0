# Copies the project's dependencies into ./node_modules on this machine so VS Code can resolve
# types and imports ("Cannot find type definition file for 'node'", unresolved 'vue', and so on).
#
# npm runs inside Docker: nothing is installed on Windows. Day-to-day tasks (dev, lint, test,
# build) keep using the faster Docker volume; this copy is only for the editor. Re-run it after
# package.json or package-lock.json change, then in VS Code run "TypeScript: Restart TS Server".
#
#   ./scripts/editor-deps.ps1
#
# --no-bin-links: Windows bind mounts cannot hold the Linux symlinks npm makes in node_modules/.bin,
# and the editor does not need them. --ignore-scripts: no install scripts, the editor only reads files.
Set-Location (Join-Path $PSScriptRoot '..')
docker run --rm -v "${PWD}:/app" -w /app `
  -e NPM_CONFIG_UPDATE_NOTIFIER=false -e NPM_CONFIG_FUND=false -e NPM_CONFIG_AUDIT=false `
  node:26-slim npm ci --no-bin-links --ignore-scripts
exit $LASTEXITCODE
