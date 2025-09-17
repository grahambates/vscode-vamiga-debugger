#!/usr/bin/env node

import { VamigaDebugAdapter } from './vamigaDebugAdapter';

// Start the debug adapter as a server
// Create a factory function to handle the different constructor signatures
class VamigaDebugAdapterWrapper extends VamigaDebugAdapter {
  constructor(_obsolete_debuggerLinesAndColumnsStartAt1?: boolean, _obsolete_isServer?: boolean) {
    // Ignore the obsolete parameters and create with default constructor
    super();
  }
}

VamigaDebugAdapter.run(VamigaDebugAdapterWrapper);