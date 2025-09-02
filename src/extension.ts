import * as vscode from 'vscode';
import { VamigaWebviewProvider } from './webviewProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new VamigaWebviewProvider(context.extensionUri);
    
    const disposable = vscode.commands.registerCommand('vamiga-debugger.openPanel', () => {
        VamigaWebviewProvider.createOrShow(context.extensionUri);
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VamigaWebviewProvider.viewType, provider)
    );
}

export function deactivate() {}