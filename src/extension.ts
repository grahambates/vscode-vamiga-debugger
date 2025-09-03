import * as vscode from 'vscode';
import { VAmigaView } from './vAmigaView';

export function activate(context: vscode.ExtensionContext) {
    const vAmiga = VAmigaView.getInstance(context.extensionUri);

    context.subscriptions.push(
        vscode.commands.registerCommand('vamiga-debugger.openPanel', () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            vAmiga.openFile(`${workspacePath}/build/program.adf`);

            // // example of receiving a message from the webview
            // this._panel.webview.onDidReceiveMessage((data) => {
            //   switch (data.type) {
            //     case "alert": {
            //       vscode.window.showInformationMessage(data.value);
            //       break;
            //     }
            //   }
            // });
        }));

    // Clean up when extension deactivates
    context.subscriptions.push({
        dispose: () => vAmiga.dispose()
    });
}

export function deactivate() { }