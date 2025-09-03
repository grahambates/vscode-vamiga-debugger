#!/usr/bin/env node

import { VamigaDebugAdapter } from './vamigaDebugAdapter';

// Start the debug adapter as a server
VamigaDebugAdapter.run(VamigaDebugAdapter);