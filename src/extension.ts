import * as vscode from 'vscode';
import { VamigaDebugAdapter } from './vamigaDebugAdapter';
import { VAmigaView } from './vAmigaView';

export function activate(context: vscode.ExtensionContext) {
  const vAmiga = new VAmigaView(context.extensionUri);

  // Register the debug adapter
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('vamiga', {
      createDebugAdapterDescriptor(
        _session: vscode.DebugSession,
      ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
          new VamigaDebugAdapter(vAmiga),
        );
      },
    }),
  );
}

export function deactivate() {}
