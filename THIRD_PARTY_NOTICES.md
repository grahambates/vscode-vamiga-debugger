# Third-Party Notices

PUAE Debugger contains software derived from third-party projects. The
notices below do not imply endorsement by the original authors. Copyright
notices and license headers in individual source files remain applicable.

## libretro-uae / PUAE

The emulator source in `puae-wasm/libretro-uae/` and the generated
`puae/puae.js` and `puae/puae.wasm` are derived from
[libretro-uae](https://github.com/libretro/libretro-uae), which is itself
derived from UAE and WinUAE.

The applicable upstream license is the GNU General Public License version 2.
See `puae-wasm/libretro-uae/COPYING`, `LICENSES/GPL-2.0-only.txt`, and the
copyright and license notices in the upstream source tree. Some bundled
upstream files and dependencies carry additional compatible licenses; their
file-level notices remain authoritative.

This project adds and modifies the wasm frontend and debugging integration.

## vscode-amiga-debug

Portions of the debugger, profiler, hardware visualizers, documentation data,
and webview code are adapted from
[vscode-amiga-debug](https://github.com/BartmanAbyss/vscode-amiga-debug),
copyright Bartman/Abyss and contributors.

The upstream project is distributed under the GNU General Public License
version 3. The adapted portions may be distributed under GPL version 2 only
when all relevant copyright holders have supplied an additional GPLv2 license
grant. Preserve the durable grant with this repository before distributing a
GPLv2 release. Until then, `LICENSES/GPL-3.0-only.txt` records the upstream
license under which those portions were received.

## engine9000-public

Portions of the emulator debugging architecture and integration are adapted
from [engine9000-public](https://github.com/alpine9000/engine9000-public),
copyright Enable Software Pty Ltd and contributors.

Unless otherwise specified by its upstream file-level notices,
engine9000-public is distributed under the GNU General Public License version
2. See `LICENSES/GPL-2.0-only.txt`. The upstream project also contains
components under other licenses; applicable notices must be retained for any
such component incorporated here.

## Modifications and source

The third-party material has been modified for the VS Code extension,
browser/webview, and WebAssembly architecture. The Git history records the
dates and content of those modifications.

The corresponding source for the checked-in JavaScript and WebAssembly
binaries consists of this repository at the matching release tag, including
the pinned `puae-wasm/libretro-uae/` source and the build scripts under
`puae-wasm/` and `scripts/`.
