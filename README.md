# PUAE Debugger

Debug Amiga (m68k) programs in VS Code with a [PUAE](https://github.com/libretro/libretro-uae) (WinUAE-derived) emulator running directly inside the editor as a webview — no external emulator process, no platform-specific binaries.

## Why

- **Fast iteration.** `fastLoad` injects your program straight into Amiga RAM, skipping the disk-boot sequence entirely — startup is close to instant.
- **Full machine range.** Because it's built on WinUAE's PUAE core rather than a from-scratch reimplementation, this isn't limited to OCS/ECS or 68000/68020 like some browser-based Amiga debuggers — 68000 through 68060, and OCS through AGA, are all supported.
- **Real visual introspection.** A cycle-accurate DMA/CPU profiler with a flame graph, per-channel DMA overlay on the live screen, a Copper disassembler, and a blitter-list visualizer — built on the same debug symbols as the rest of the debugging session, not a separate reverse-engineering tool.
- **No native binaries to install.** The emulator core is WebAssembly, so there's nothing platform-specific to build or ship alongside the extension.

## Getting started

You'll need:

- A **Kickstart ROM** file for the model you're targeting (not included — bring your own; see [Requirements](#requirements)).
- A `m68k` language extension for syntax highlighting and language features, e.g. [Motorola 68000 Assembly](https://marketplace.visualstudio.com/items?itemName=gigabates.m68k-lsp) or [Amiga Assembly](https://marketplace.visualstudio.com/items?itemName=prb28.amiga-assembly).
- A toolchain that emits debug info the extension understands: [vasm](http://sun.hasenbraten.de/vasm/)/[vlink](http://sun.hasenbraten.de/vlink/) (assembly, `-linedebug`/GNU stabs) or [vbcc](http://www.compilersandtools.com/vbcc) / [bebbo's Amiga GCC](https://github.com/bebbo/amiga-gcc) (C/C++, DWARF or stabs) — see [Source-level debugging](#source-level-debugging) below.

Add a launch configuration to `.vscode/launch.json` — use one of the built-in snippets (type `PUAE:` when creating a new configuration) or write one directly:

```jsonc
{
  "type": "puae",
  "request": "launch",
  "name": "Launch PUAE",
  "program": "${workspaceFolder}/out/a.exe",
  "fastLoad": true,
  "stopOnEntry": true,
  "kickstartRom": "${workspaceFolder}/roms/kick13.rom",
  "emulatorOptions": {
    "cpu_model": 68000,
    "chipmem_size": 2,
    "bogomem_size": 2,
    "chipset": "ocs"
  }
}
```

Then hit F5. Every WinUAE `.uae` config key is accepted under `emulatorOptions` (a subset has IntelliSense/validation; anything else is passed through verbatim), so existing WinUAE quickstart configs or hand-tuned setups carry over directly. `emulatorConfigFile` can point at a full `.uae` file to use as a base, with `emulatorOptions` overriding individual keys.

## Debugging

- **Breakpoints**: source-line, instruction, function/symbol, conditional and hit-count breakpoints, and logpoints — evaluated using the same expression syntax as the Debug Console (see below).
- **Data breakpoints (watchpoints)**: set on symbols (with size auto-derived from DWARF type info or a `dc.*` declaration), CPU registers (break on value change), or custom chipset registers — including ones like `DMACON` where the read and write addresses differ. Watchpoint hit reports distinguish the CPU, the Copper, or the Blitter/disk DMA as the writer, and jump straight to the responsible Copper source line when applicable. Default watchpoint length is inferred but overridable per-breakpoint.
- **Exception catchpoints**: Bus error, Address error, Illegal instruction, Zero divide, Privilege violation — plus a "Write to unallocated memory" filter backed by live AllocMem/FreeMem tracking, so bad pointer writes get caught even without a symbol.
- **Stepping**: line and instruction granularity, step into/over/out — synthesized on top of PUAE's plain run/pause primitives by decoding the current instruction and placing a temporary breakpoint (`jsr`/`bsr`/`dbra` for step-over, the live shadow call stack for step-out).
- **Reverse debugging**: step back one instruction, continue in reverse until the previous breakpoint, or jump to the start/end of the current frame or the end of the current scanline — backed by periodic full-state checkpoints plus exact-instruction replay between them, so it lands precisely, not just at the nearest checkpoint.
- **Debug Console / REPL**: a JavaScript-like expression language for reading and writing emulator state — CPU/custom registers and program symbols are usable as bare variable names, plus helpers like `peekU32(addr)` / `poke16(addr, value)`, `readBytes`/`readWords`/`readLongs` for hex dumps, `disassemble(addr)`, `disassembleCopper(addr)`, and `trace()` for recent instruction history. Type `help` for the full guide.
- **C/C++ expressions**: hovers, watches, and `setExpression` understand `.`, `->`, `[]`, `*`, `&` over DWARF-typed locals and globals for C/C++ programs, falling back to the assembly/REPL evaluator otherwise.
- **Disassembly view**: VS Code's built-in disassembly view is fully wired up, including for addresses with no source mapping (Kickstart calls, etc.) — the ROM is identified by SHA-1 and its calls are labelled using an embedded symbol table where available.

## Source-level debugging

Debug info is auto-detected from the file's actual bytes, not its extension:

- **Amiga Hunk executables**: `-linedebug`-style line hunks (vasm) or GCC stabs embedded in `HUNK_DEBUG` blocks.
- **ELF binaries**: DWARF (`.debug_info`/`.debug_line`) or GNU stabs.

DWARF gets you the most: `.debug_frame`-based stack unwinding (used by the debugger's call stack and the profiler's unwind table) and inline function expansion (`DW_TAG_inlined_subroutine`), giving proper innermost-first inline call chains. Assembly builds without DWARF still get full locals/globals/line mapping — the debugger falls back to a live, self-correcting shadow call stack maintained by the emulator core itself (tracking `jsr`/`bsr`/exception entry against `rts`/`rte`) rather than a heuristic stack scan.

## Memory Viewer

Open from the debug toolbar, the command palette, or by right-clicking a symbol in the Variables view ("View in Memory Viewer"). Four views over the same address space:

- **Hex Dump** — with per-byte watchpoint toggling directly from the view.
- **Visual** — a bitmap render of raw memory with automatic stride-guessing, for eyeballing bitplane/sprite data.
- **Disassembly** and **Copper** — CPU and Copper-list disassembly at an address.

The address bar accepts a numeric address or an expression, with autocomplete over symbol names. A region selector switches between Chip/Slow/Fast/Kickstart RAM, and "Save to Disk..." exports a raw memory range.

## Amiga State Viewer

A live GUI view of Amiga hardware state that isn't easily read from a register dump: bitplane count, Hi-Res/Interlace/HAM/dual-playfield flags, palette, playfield priority, screen geometry, and ECS/AGA-specific flags — plus a Memory Allocations tab showing live Chip/Slow/Fast RAM usage and a clickable list of currently allocated blocks (from the same AllocMem/FreeMem tracking that backs the "write to unallocated memory" catchpoint) that jumps straight into the Memory Viewer.

## Live emulator view

The webview isn't just a passive screen:

- **DMA overlay** — per-channel toggles (Refresh/CPU/Copper/Audio/Blitter/Bitplane/Sprite/Disk, with an "all" toggle and shift-click isolate) drawn directly onto the running frame, with an opacity slider and a hover tooltip showing Copper disassembly or DMA cycle info — click through to the responsible source line.
- **Blit visualizer** — highlights blitter destination regions as they're written, with a configurable fade/decay.
- **Per-channel mute** — individual bitplanes, sprites, audio channels, and the blitter, useful for isolating what's producing a given visual or audio artifact.
- **Warp mode** — uncapped-speed emulation (auto-engaged while a non-`fastLoad` boot is still loading), plus a slow-motion speed dropdown for the opposite case. Cycle-exact CPU/DMA-contention modeling is a genuine runtime toggle, not just a speed cap, so warp mode is actually fast.
- **Mouse and keyboard capture** — pointer lock for the emulated Amiga mouse, keyboard forwarding while the canvas is focused.

## CPU/DMA Profiler

Capture 1–500 frames of full DMA-cycle and CPU-instruction detail ("Capture Frame Profile" on the debug toolbar) and explore it across several linked views, all synced to one shared timeline:

- **Flame graph** — top-down or bottom-up call trees, filterable by function/file name (including regex).
- **CPU/Disassembly** — per-instruction cycle and hit-count heat-map, branch/jump arrow lanes, register value history, source correlation.
- **DMA/Screen** — full frame reconstruction from the captured DMA grid, with per-pixel hover showing the raw bitplane bits, resolved palette color, HAM decode, sprite ownership, and the Copper instruction that set it up.
- **Copper** — per-instruction disassembly of the captured Copper list with source lookup.
- **Blitter** — reconstructed blit list with a per-blit detail grid.
- **Memory** — byte-level chip/slow RAM reconstruction at any point in the captured range.

Multi-frame captures get a filmstrip of thumbnails (hover to enlarge) and support shift-click range selection to combine several frames into one continuous timeline. Panels can be split side-by-side (horizontal or vertical), and results save to a self-contained `.puaeprofile` file — it embeds the program binary, relocation info, and Kickstart ROM identity, so a teammate can open a shared capture and get identical symbolication without your build environment or ROM file.

Profiler data also surfaces back in the editor: per-line heat-tinted background + cycle/hit counts (toggle via "Toggle Line Profiler Annotations"), a CodeLens above each profiled function ("X% Self, Y% Total"), and "Jump to Next Execution in Profiler" from the editor context menu.

## Configuration reference

Full schema with inline documentation is available via IntelliSense in `launch.json`. Key options:

| Option | Purpose |
|---|---|
| `program` | Path to the executable to run |
| `debugProgram` | Separate file to read debug symbols from, if different from `program` |
| `fastLoad` | Inject the program directly into memory instead of booting from disk |
| `hardDrivePath` | (non-`fastLoad`) Mount a host directory as `DH0:` instead of the auto-generated single-program disk — lets the program use its own libraries, data files, and `s/startup-sequence` |
| `kickstartRom` | Path to the Kickstart ROM file (required) |
| `emulatorConfigFile` | Base WinUAE-format `.uae` file |
| `emulatorOptions` | Raw WinUAE `.uae` key/value overrides — `quickstart` machine presets (e.g. `"A1200,1"`), CPU/chipset/RAM sizing, floppy/sound/display options, and any other WinUAE key |
| `stopOnEntry` | Pause immediately after launch |

## Requirements

- **Kickstart ROM**: not included, for copyright reasons — supply your own dump matching the machine you're targeting.
- VS Code 1.104 or later.

## License

This project is licensed under the [GNU General Public License version 2](LICENSE.txt). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution, component licensing, and source provenance.

Emulation is powered by [PUAE](https://github.com/libretro/libretro-uae) (libretro-uae), derived from WinUAE by Toni Wilen and contributors.
