import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.74.0',
  workspaceFolder: './test-workspace',
  mocha: {
    ui: 'tdd',
    timeout: 20000
  }
});