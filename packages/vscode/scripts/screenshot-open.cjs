// Runs in the extension host of the VS Code that screenshot.mjs starts: opens the quiz in the
// preview and keeps the window open, as VS Code closes it once this returns; the script closes it.
const vscode = require('vscode')

exports.run = async function run() {
  const [folder] = vscode.workspace.workspaceFolders ?? []
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(folder.uri, 'quiz.h5p'), 'missingElements.h5pPreview')
  await new Promise(() => {})
}
