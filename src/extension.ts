import * as vscode from 'vscode';
import { VamigaDebugAdapter } from './vamigaDebugAdapter';

export function activate(context: vscode.ExtensionContext) {
  // Register the debug adapter
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('vamiga', {
      createDebugAdapterDescriptor(
        _session: vscode.DebugSession,
      ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
          new VamigaDebugAdapter(),
        );
      },
    }),
  );
}

export function deactivate() {}
