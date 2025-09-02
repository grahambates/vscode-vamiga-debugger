import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('Sample test', () => {
        assert.strictEqual(-1, [1, 2, 3].indexOf(5));
        assert.strictEqual(0, [1, 2, 3].indexOf(1));
    });

    test('Extension should be present', () => {
        assert.ok(vscode.extensions.getExtension('undefined_publisher.vscode-vamiga-debugger'));
    });
});