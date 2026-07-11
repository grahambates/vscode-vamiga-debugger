import { decodeInstruction as m68kDecode, instructionToString } from "m68kdecode";
import { SourceMap } from "./sourceMap";
import { buildUnwindTable } from "./unwindTable";
import {
  ProfileFrame,
  IProfileModel,
  IComputedNode,
  ILocation,
  ISymbol,
  IDisassembledFunction,
  Category,
  REG_COUNT,
  ILineTableEntry,
  ISegmentRange,
} from "./shared/profilerTypes";
import { decodeDmaGrid, decodeCustomRegs, decodeAgaColors, decodeCopperRecords, decodeDmaEvents, decodeRegisterTrace } from "./dma";

export type { ProfileFrame, IProfileModel };

// Flatten the source map's symbols into the address-sorted {address,name,size} list the webview
// symbolizer consumes. Sizes come from getSymbolLengths (clamped to segment end). excludeLocal=
// true so this agrees with the flame graph's function attribution (symbolicate/expandPc also pass
// excludeLocal=true) — otherwise a vasm local label (e.g. a macro's `.\@` branch target) would
// split a routine's symbol-list entry at the label instead of the webview resolving addresses
// past it back to the enclosing routine.
function buildSymbolList(sourceMap: SourceMap): ISymbol[] {
  const addrs = sourceMap.getSymbols(true); // name -> address
  const sizes = sourceMap.getSymbolLengths(true) ?? {}; // name -> size
  const out: ISymbol[] = [];
  for (const name in addrs) {
    out.push({ address: addrs[name], name, size: sizes[name] ?? 0 });
  }
  out.sort((a, b) => a.address - b.address);
  return out;
}

// Minimal RPC surface (WebviewEmulator.sendRpcCommand) — kept as an interface so the manager
// is unit-testable with a mock and doesn't pull in the whole emulator/webview module.
export interface ProfilerRpcClient {
  sendRpcCommand<T = unknown, A = unknown>(command: string, args?: A, timeoutMs?: number): Promise<T>;
}

// One captured instruction: the reconstructed call stack (leaf-first, as the
// emulator emits it) and the cycles attributed to that instruction.
export interface InstructionSample {
  stack: number[]; // absolute PCs, innermost (leaf) first
  cycles: number;
}

// Hard cap mirroring the emulator's kMaxDepth; guards against a corrupt stream.
const MAX_DEPTH = 64;

// Synthetic leaf-PC marker for an [IRQ] sample (the interrupt/exception dispatch
// "gap") — value inherited from the vAmiga emulator project's own CpuProfiler.h,
// which used this sentinel for the same purpose.
const IRQ_MARKER = 0xfffffffe;

// Kickstart ROM address range (covers 256K and 512K ROMs), as in WinUAE.
const KICKSTART_ROM_START = 0xf80000;
const KICKSTART_ROM_END = 0x1000000;

// Classify a leaf PC into a synthetic bucket label, or undefined for normal in-program
// code. Precedence mirrors the old vscode-amiga-debug: [IRQ] (dispatch-gap marker) >
// Kickstart (ROM range) > program (a loaded segment → normal) > [External] (anything else).
// A ROM PC resolves to "[Kick] <name>" when Kickstart symbols are loaded (kickstartRomPath
// + a known ROM, merged into the SourceMap as the .kick module) — useful since demoscene/
// bare-metal code still calls ROM routines (WaitBlit, etc.) — or flat "[Kickstart]" otherwise.
// The symbol NAME only (no offset) so all PCs within one ROM routine aggregate into one node.
export function syntheticLabel(pc: number, sourceMap: SourceMap): string | undefined {
  if (pc === IRQ_MARKER) return "[IRQ]";
  if (pc >= KICKSTART_ROM_START && pc < KICKSTART_ROM_END) {
    const sym = sourceMap.findSymbolOffset(pc, true);
    return sym ? `[Kick] ${sym.symbol}` : "[Kickstart]";
  }
  if (sourceMap.findSegmentForAddress(pc)) return undefined;
  return "[External]";
}

// Decode the flat u32 stream the emulator produces. Record layout, repeated:
//   [depth, pc0, pc1, ... pc(depth-1), cycleDelta]
// pc0 is the leaf. Returns one InstructionSample per record; stops cleanly on a
// truncated/!plausible record rather than throwing.
export function decodeProfileStream(words: Uint32Array): InstructionSample[] {
  const samples: InstructionSample[] = [];
  let i = 0;
  while (i < words.length) {
    const depth = words[i++];
    if (depth === 0 || depth > MAX_DEPTH) break; // implausible -> stop
    if (i + depth + 1 > words.length) break; // truncated -> stop
    const stack: number[] = [];
    for (let d = 0; d < depth; d++) stack.push(words[i++]);
    const cycles = words[i++];
    samples.push({ stack, cycles });
  }
  return samples;
}

// Expand a PC into its logical call frames, outermost-first: the physical (concrete)
// function that contains the code, followed by one frame per inlined function (DWARF
// DW_TAG_inlined_subroutine). Inlined functions have no runtime stack frame, so the
// unwinder never sees them — they only exist in the line/inline tables and must be
// reconstructed here, or the flame graph/time view shows the caller and silently
// skips every inlined callee.
//
// Line attribution follows addr2line --inlines (and the old vscode-amiga-debug): each
// frame is shown at the *call site* of the next-inner frame (the line where the inline
// call appears in the caller), and only the innermost frame gets the instruction's own
// source line. `getInlineFramesForPc` returns frames innermost-first.
function expandPc(pc: number, sourceMap: SourceMap): ProfileFrame[] {
  const synthetic = syntheticLabel(pc, sourceMap);
  if (synthetic) return [{ func: synthetic, file: undefined, line: undefined, address: pc }];
  const sym = sourceMap.findSymbolOffset(pc, true);
  const loc = sourceMap.lookupAddress(pc);
  const funcName = sym ? sym.symbol : `0x${pc.toString(16)}`;
  const inlines = sourceMap.getInlineFramesForPc?.(pc) ?? []; // innermost-first
  if (inlines.length === 0) {
    // No inlining (typical for assembly): resolve file/line at the symbol's own address,
    // not pc, so a function invoked via a macro carrying its own line-table entry (e.g. an
    // include) still resolves to one consistent location instead of splitting per call site.
    const declLoc = sym ? sourceMap.lookupAddress(pc - sym.offset) : loc;
    return [{ func: funcName, file: declLoc?.path, line: declLoc?.line, address: pc }];
  }
  const n = inlines.length;
  // Inlined frames are suffixed " (inlined)" (matching the old vscode-amiga-debug) so the
  // flame graph / time view distinguish them from the physical function they live in.
  const frames: ProfileFrame[] = [
    // Physical function: rendered at the line where the outermost inline was called.
    { func: funcName, file: inlines[n - 1].callPath || undefined, line: inlines[n - 1].callLine || undefined, address: pc },
  ];
  // Each inline (outer→inner) is shown at the call site of the next-inner inline...
  for (let k = n - 1; k >= 1; k--) {
    frames.push({ func: inlines[k].name + " (inlined)", file: inlines[k - 1].callPath || undefined, line: inlines[k - 1].callLine || undefined, address: pc });
  }
  // ...and the innermost inline gets the instruction's own source location.
  frames.push({ func: inlines[0].name + " (inlined)", file: loc?.path, line: loc?.line, address: pc });
  return frames;
}

// Nest "context-less" leaves under the program call stack, porting the old vscode-amiga-
// debug `lastCallstack` reuse: a depth-1 leaf the unwinder couldn't step out of inherits
// the previous in-program sample's stack as context, so it renders below its caller and
// its cycles roll up into the CPU total. Two kinds of context-less leaf:
//   * out-of-program ([Kickstart]/[External]) — DWARF can't unwind from ROM/elsewhere;
//   * a no-DWARF-CFI leaf *inside* the program — an #embed'd binary or hand-asm called via
//     jsr (e.g. ThePlayer in template.c, in .rodata): symbolized normally but with no CFI,
//     so the emulator emits it depth-1. `getCfaForPc` is the reliable signal — real C code
//     always has CFI, so a no-CFI leaf is a no-debug blob (the only other no-CFI code,
//     crt0/_start, is a genuine root and isn't sampled mid-frame).
// [IRQ] markers stay standalone (dispatch overhead, not attributable to a function), and
// branch-stack samples already carry real context (depth > 1) and pass through unchanged.
// Operates on raw PCs and returns a new array, leaving the input `samples` (the raw
// artifact returned by getSamples) untouched.
export function applyContextReuse(samples: InstructionSample[], sourceMap: SourceMap): InstructionSample[] {
  // The no-CFI-blob nesting only makes sense for a DWARF program: there, every real
  // function has CFI, so a no-CFI leaf is a no-debug blob. A pure-assembly (branch-stack)
  // capture has NO DWARF at all — getCfaForPc is always undefined and depth-1 leaves are
  // legitimate (the shadow stack), so blob-nesting must be disabled. getUnwindRows() is the
  // "has DWARF CFI" signal (empty for asm); compute it once.
  const hasCfi = sourceMap.getUnwindRows().length > 0;
  let lastProgramStack: number[] = [];
  return samples.map((s) => {
    const leaf = s.stack[0];
    const synthetic = syntheticLabel(leaf, sourceMap);
    if (synthetic === "[IRQ]") return s; // standalone, never nested or reused as context

    const depth1 = s.stack.length === 1;
    const outOfProgram = synthetic !== undefined; // [Kickstart]/[External]
    const noCfiBlob = hasCfi && !outOfProgram && depth1 && !sourceMap.getCfaForPc(leaf);

    // Nest a context-less leaf (out-of-program, or an in-program no-CFI blob) under the
    // last real program stack so it hangs off its caller instead of floating at the root.
    if (depth1 && (outOfProgram || noCfiBlob) && lastProgramStack.length > 0) {
      return { stack: [leaf, ...lastProgramStack], cycles: s.cycles };
    }

    // Genuine program code (resolvable C with a caller chain, or a real root like an
    // interrupt handler): remember it as context for subsequent context-less leaves.
    if (!outOfProgram && !noCfiBlob) lastProgramStack = s.stack;
    return s;
  });
}

// Drop the OS/Kickstart ancestor prefix from the ROOT end of a leaf-first stack, so the
// flame graph starts at the user's own program instead of showing the DOS/Kickstart call
// chain that launched it (process creation, task scheduler, library JSRs, ...) sitting
// above every sample. Only relevant for a branch-stack (assembly/LINE, no-DWARF) capture:
// the shadow call stack (puae_debug_callstack) accumulates from emulator boot, so it still
// carries whatever was on it when the program's own entry point started running.
//
// Scans from the root (stack's last element) toward the leaf (index 0) and trims off every
// out-of-program frame up to — but not including — the first in-program one; frames from
// there to the leaf are kept as-is, including any Kickstart/External calls made FROM within
// the program (AllocMem, WaitBlit, ...), since those are genuine nested calls, not launch
// ancestry. A stack with no in-program frame at all (e.g. a pure-Kickstart/External sample)
// is left untouched — there's no "first user code" to start at.
//
// "In program" is judged via syntheticLabel, NOT sourceMap.findSegmentForAddress directly:
// addSymbolModule() (used to merge Kickstart ROM symbols in) registers the ROM range as a
// `segment` too, so findSegmentForAddress alone returns truthy for Kickstart addresses once
// those symbols are loaded — which would make this function a no-op. syntheticLabel already
// excludes the Kickstart ROM range (and the IRQ marker) before falling back to the segment
// check, so it's the correct "is this genuinely the user's own program" predicate.
export function trimToProgramRoot(samples: InstructionSample[], sourceMap: SourceMap): InstructionSample[] {
  const inProgram = (pc: number) => syntheticLabel(pc, sourceMap) === undefined;
  return samples.map((s) => {
    const stack = s.stack;
    let rootIdx = stack.length - 1;
    while (rootIdx > 0 && !inProgram(stack[rootIdx])) rootIdx--;
    if (rootIdx === stack.length - 1) return s; // already starts in-program
    if (!inProgram(stack[rootIdx])) return s; // no in-program frame at all
    return { stack: stack.slice(0, rootIdx + 1), cycles: s.cycles };
  });
}

// Build the time-ordered IProfileModel the flame chart renders, from the per-
// instruction samples. Ports the structure of the old vscode-amiga-debug
// `buildModel` but sources it from our stacks instead of a CDP profile:
//   - locations[] interned per PC (symbolicated once),
//   - nodes[] a call tree (synthetic root = node 0, real frames hang below it),
//   - samples[] the leaf node id per instruction in execution order (samples[0] is
//     a dummy paired with timeDeltas — matches the offset buildColumns expects),
//   - timeDeltas[] the per-instruction cycle cost; duration = total cycles.
export function buildProfileModel(samples: InstructionSample[], sourceMap: SourceMap, cyclesPerMicroSecond = 7.09379): IProfileModel {
  const locations: ILocation[] = [];
  // Key: "functionName:url" — all instructions within the same function share one location.
  // This matches the V8/CDP convention where callFrame.lineNumber = function declaration line,
  // not the current instruction's source line.
  const locByFunc = new Map<string, number>();

  // Synthetic root location (node 0). Never rendered — buildColumns stops before it.
  locations.push({
    id: 0,
    selfTime: 0,
    aggregateTime: 0,
    category: Category.System,
    callFrame: { functionName: "(all)", url: "", scriptId: "root", lineNumber: -1, columnNumber: 0 },
    address: 0,
  });

  const internLocation = (f: ProfileFrame): number => {
    const funcKey = `${f.func}:${f.file ?? ""}`;
    let idx = locByFunc.get(funcKey);
    if (idx === undefined) {
      idx = locations.length;
      locations.push({
        id: idx,
        selfTime: 0,
        aggregateTime: 0,
        // No source file ⇒ treat as system/OS (renders gray); program code is User.
        category: f.file ? Category.User : Category.System,
        callFrame: {
          functionName: f.func,
          url: f.file ?? "",
          scriptId: "0",
          lineNumber: f.line !== undefined ? f.line : -1,
          columnNumber: 0,
        },
        address: f.address,
      });
      locByFunc.set(funcKey, idx);
    }
    return idx;
  };

  // Expand each PC into its logical frames (physical + inlines) once, caching the
  // resulting location-id chain (outermost→innermost) so hot PCs aren't re-symbolicated.
  const locIdsByPc = new Map<number, number[]>();
  const locIdsFor = (pc: number): number[] => {
    let ids = locIdsByPc.get(pc);
    if (!ids) {
      ids = expandPc(pc, sourceMap).map(internLocation);
      locIdsByPc.set(pc, ids);
    }
    return ids;
  };

  // Call tree: synthetic root node 0, then a child per distinct (parent, location).
  const nodes: IComputedNode[] = [
    { id: 0, selfTime: 0, aggregateTime: 0, children: [], locationId: 0 },
  ];
  const childByNode = new Map<number, Map<number, number>>();
  const childNode = (parentId: number, locId: number): number => {
    let m = childByNode.get(parentId);
    if (!m) { m = new Map(); childByNode.set(parentId, m); }
    let cid = m.get(locId);
    if (cid === undefined) {
      cid = nodes.length;
      nodes.push({ id: cid, selfTime: 0, aggregateTime: 0, children: [], parent: parentId, locationId: locId });
      nodes[parentId].children.push(cid);
      m.set(locId, cid);
    }
    return cid;
  };

  const sampleIds: number[] = [0]; // samples[0] dummy; pairs with timeDeltas[i-1]
  const timeDeltas: number[] = [];
  // Exact PC per sample, in lockstep with timeDeltas (pcs[k] is timeDeltas[k]'s instruction).
  // `locations[].address` is NOT this — locations are deduped per function (internLocation keys
  // on functionName:file), so every sample within the same function shares one location object
  // whose `address` is frozen to whichever PC first created it. buildColumns reads `pcs` to give
  // each column's leaf cell its own real address, which the Disassembly view needs to highlight
  // the actual current instruction (not just the current function) as the time cursor moves.
  const pcs: number[] = [];
  let duration = 0;
  for (const s of applyContextReuse(trimToProgramRoot(samples, sourceMap), sourceMap)) {
    // Stacks are leaf-first; descend outermost→leaf so the path hangs off the root.
    // Each physical PC expands to physical + inlined frames (outermost→innermost), so
    // inlined callees appear as their own boxes stacked above the caller.
    let nodeId = 0;
    for (let i = s.stack.length - 1; i >= 0; i--) {
      for (const locId of locIdsFor(s.stack[i])) {
        nodeId = childNode(nodeId, locId);
      }
    }
    nodes[nodeId].selfTime += s.cycles; // innermost (inlined) frame accrues self time
    sampleIds.push(nodeId);
    timeDeltas.push(s.cycles);
    pcs.push(s.stack[0]);
    duration += s.cycles;
  }

  // Aggregate (inclusive) time per node, folded back into the shared locations.
  const computeAgg = (id: number): number => {
    const n = nodes[id];
    if (n.aggregateTime) return n.aggregateTime;
    let total = n.selfTime;
    for (const c of n.children) total += computeAgg(c);
    return (n.aggregateTime = total);
  };
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const loc = locations[n.locationId];
    loc.aggregateTime += computeAgg(i);
    loc.selfTime += n.selfTime;
  }

  return {
    nodes,
    locations,
    samples: sampleIds,
    timeDeltas,
    pcs,
    duration,
    cyclesPerMicroSecond,
  };
}

// Raw (pre-symbolication) disassembly: everything that required a live wasm session to produce
// (the instruction text/bytes from _wasm_disassemble, and the hit/cycle counts aggregated from
// the exact per-instruction sample trace) — NOT yet annotated with source file/line, which is
// re-derived in attachDisassembly() from whichever SourceMap is active (live session or a
// reconstructed one for a loaded .puaeprofile), mirroring how the rest of IProfileModel is
// rebuilt from RawCapture rather than baked in once.
export interface RawDisassembledInstruction {
  address: number;
  hex: string;
  text: string;
  length: number;
  hits: number;
  cycles: number;
  jumpTarget?: number;
}
export interface RawDisassembledFunction {
  address: number;
  name: string;
  instructions: RawDisassembledInstruction[];
}

// The raw, serializable result of one capture — everything the post-emulator pipeline
// consumes, before any decoding or symbolication. This is the seam shared by live capture
// and a loaded .puaeprofile: both produce a RawCapture, then buildModelFromCapture turns
// it into the IProfileModel. Kept to plain typed arrays + scalars so it serializes directly.
export interface RawCapture {
  profile: {
    data: Uint8Array; // the raw [depth,…pcs,cycles] stream from wasm_profile_get_data
    start: number;
    end: number;
    total: number;
    inRange: number;
    frameCycles: number; // CPU-clock cycles in the profiled frame (0 = emulator didn't report)
    isPAL: boolean; // normalized at the RPC boundary (defaults true)
  };
  dma?: Uint8Array; // raw enriched DMA grid bytes (absent if DMA capture produced nothing)
  // Reconstruction baseline (raw bytes; `custom` is 256 little-endian u16 = the custom-register
  // file at capture start, used for DMACON / register reconstruction).
  snapshot?: { chip: Uint8Array; slow: Uint8Array; fast?: Uint8Array; fastAddr?: number; custom: Uint8Array; agaColors?: Uint8Array };
  copper?: Uint8Array; // raw copper-instruction-trace bytes (absent if unsupported/empty)
  dmaEvents?: Uint8Array; // raw per-cycle event-bitfield bytes, parallel to `dma` (absent if unsupported/empty)
  disassembly?: RawDisassembledFunction[]; // every function that executed this frame (absent if unsupported/empty)
  registers?: Uint8Array; // raw per-sample register trace bytes, parallel to `profile.data` (absent if unsupported/empty)
  // JPEG thumbnail of the framebuffer at capture time, for the multi-frame filmstrip UI.
  thumbnail?: { data: Uint8Array; width: number; height: number };
  // Full-resolution JPEG of the framebuffer, for hover-to-enlarge in the filmstrip.
  fullFrame?: { data: Uint8Array; width: number; height: number };
}

// One captured frame: the decoded model + the raw bytes it was built from.
// capture() returns an array of these; single-frame captures produce a one-element array.
// `combined` is only present on frames[0] when numFrames > 1: a model built from all N
// frames' InstructionSamples concatenated, giving correct aggregate node/location times
// and a combined flame-graph timeline across the full capture.
export interface FrameCapture {
  model: IProfileModel;
  raw: RawCapture;
  combined?: IProfileModel;
}

// Pure transform: RawCapture + SourceMap → IProfileModel (+ the decoded samples, retained
// as a first-class artifact). No I/O, no emulator — the single model-building path for both
// live captures and loaded .puaeprofile files, and the unit-test entry point. An empty
// capture yields an empty model here; the live "nothing captured" diagnostic lives in
// ProfilerManager.capture() where the emulator-state hint makes sense.
export function buildModelFromCapture(
  raw: RawCapture,
  sourceMap: SourceMap,
): { model: IProfileModel; samples: InstructionSample[] } {
  const pb = raw.profile;
  const words = new Uint32Array(pb.data.buffer, pb.data.byteOffset, pb.data.byteLength >>> 2);
  const samples = decodeProfileStream(words);

  // Derive the CPU clock from the measured frame cycles + PAL/NTSC (PAL = 50 Hz/20000 µs,
  // NTSC = 60 Hz). frameCycles == 0 means the emulator didn't report one → standard PAL constant.
  const frameUs = pb.isPAL ? 20000 : 1_000_000 / 60;
  const cyclesPerMicroSecond = pb.frameCycles > 0 ? pb.frameCycles / frameUs : 7.09379;

  const model = buildProfileModel(samples, sourceMap, cyclesPerMicroSecond);
  model.symbols = buildSymbolList(sourceMap);
  model.lineTable = sourceMap.getLineTable().map((e): ILineTableEntry => ({ address: e.address, file: e.path, line: e.line }));
  model.segments = sourceMap.getSegmentsInfo().map((s): ISegmentRange => ({ address: s.address, size: s.size }));

  if (raw.dma) {
    const dma = decodeDmaGrid(raw.dma);
    if (dma) {
      model.dma = dma;
      if (raw.snapshot) {
        model.dmaSnapshot = {
          chip: raw.snapshot.chip,
          slow: raw.snapshot.slow,
          custom: decodeCustomRegs(raw.snapshot.custom),
          agaColors: decodeAgaColors(raw.snapshot.agaColors),
        };
      }
      // Only attach if it lines up with the grid — a mismatched length (stale/corrupt capture)
      // must not desync events[slot] from owner[slot] elsewhere.
      if (raw.dmaEvents) {
        const events = decodeDmaEvents(raw.dmaEvents);
        if (events && events.length === dma.owner.length) dma.events = events;
      }
    }
  }
  if (raw.copper) model.copper = decodeCopperRecords(raw.copper);
  if (raw.disassembly) model.disassembly = attachDisassembly(raw.disassembly, sourceMap);
  if (raw.registers) {
    const decoded = decodeRegisterTrace(raw.registers);
    // Clip to model.pcs.length (decodeProfileStream can stop early on a corrupt/truncated
    // stream; the wasm side keeps both buffers in lockstep, so this only guards that JS-side
    // edge case) — never let registers[] outrun the samples it's supposed to align with.
    const wordsNeeded = model.pcs.length * REG_COUNT;
    model.registers = decoded.length > wordsNeeded ? decoded.subarray(0, wordsNeeded) : decoded;
  }
  return { model, samples };
}

// Re-derive each instruction's source file/line from `sourceMap` (the wasm-produced text/bytes/
// stats in `raw` are already final — see RawDisassembledFunction's comment). `line` is stored
// 1-based, straight from lookupAddress().line — see IDisassembledInstruction.line/ProfileFrame.line.
export function attachDisassembly(raw: RawDisassembledFunction[], sourceMap: SourceMap): IDisassembledFunction[] {
  return raw.map((fn) => ({
    address: fn.address,
    name: fn.name,
    instructions: fn.instructions.map((ins) => {
      const loc = sourceMap.lookupAddress(ins.address);
      return { ...ins, file: loc?.path, line: loc?.line };
    }),
  }));
}

// Hard cap on how many distinct functions get disassembled per capture — a safety valve for a
// pathological profile that touches many tiny functions, not a real-world limit. Sorted by total
// cycles descending first, so a cap (if ever hit) drops the coldest functions, not the hottest.
const MAX_DISASSEMBLE_FUNCTIONS = 64;

// Re-apply per-instruction hit/cycle counts from a new sample set onto an existing
// disassembly template (instruction text + addresses unchanged from the template). Used
// to give frames 1..N-1 correct per-frame counts without re-running the expensive
// disassemble RPC, and to produce the combined-all-frames disassembly.
function reweightDisassembly(
  template: RawDisassembledFunction[],
  samples: InstructionSample[],
): RawDisassembledFunction[] {
  const pcStats = new Map<number, { hits: number; cycles: number }>();
  for (const s of samples) {
    const pc = s.stack[0];
    const e = pcStats.get(pc);
    if (e) { e.hits++; e.cycles += s.cycles; }
    else pcStats.set(pc, { hits: 1, cycles: s.cycles });
  }
  return template.map((fn) => ({
    ...fn,
    instructions: fn.instructions.map((ins) => {
      const stat = pcStats.get(ins.address);
      return { ...ins, hits: stat?.hits ?? 0, cycles: stat?.cycles ?? 0 };
    }),
  }));
}

// Disassemble a [startAddr, endAddr) range directly from snapshot memory using m68kdecode.
// chipMem starts at address 0x000000; slowMem (Bogo RAM) starts at 0xC00000; fastMem (Zorro II
// fast RAM) starts at fastAddr — unlike chip/slow, fast RAM's start address is autoconfig-
// assigned rather than architecturally fixed, so it's passed in rather than hardcoded (see
// wasm_dma_get_fast_addr's comment in puae_debug.c). Functions outside all of these regions
// (Zorro III fast RAM, ROM) return an empty instruction array rather than erroring — Z3 isn't
// reachable by this debug layer yet regardless (PCs are unconditionally masked to 24 bits).
function clientDisassembleRange(
  chipMem: Uint8Array,
  slowMem: Uint8Array | undefined,
  startAddr: number,
  endAddr: number,
  fastMem?: Uint8Array,
  fastAddr?: number,
): { address: number; hex: string; text: string; length: number; jumpTarget?: number }[] {
  const instructions: { address: number; hex: string; text: string; length: number; jumpTarget?: number }[] = [];
  let addr = startAddr >>> 0;
  const end = endAddr >>> 0;
  while (addr < end && instructions.length < 8192) {
    let mem: Uint8Array | null = null;
    if (addr < chipMem.length) {
      mem = chipMem.subarray(addr);
    } else if (slowMem && addr >= 0xC00000 && addr < 0xC00000 + slowMem.length) {
      mem = slowMem.subarray(addr - 0xC00000);
    } else if (fastMem && fastAddr !== undefined && addr >= fastAddr && addr < fastAddr + fastMem.length) {
      mem = fastMem.subarray(addr - fastAddr);
    }
    if (!mem || mem.length < 2) break;
    let bytesUsed = 2;
    let text = "dc.w $" + ((mem[0] << 8 | mem[1]) >>> 0).toString(16).toUpperCase().padStart(4, "0");
    let jumpTarget: number | undefined;
    try {
      const decoded = m68kDecode(mem);
      bytesUsed = Math.max(decoded.bytesUsed, 2);
      text = instructionToString(decoded.instruction).trim();
      const { operation, operands } = decoded.instruction;
      if (operation === "BRA" || operation === "BCC" || operation === "BSR") {
        const op = operands[0];
        if (op?.kind === "PCDISP") jumpTarget = (addr + op.offset + op.disp.baseDisplacement) >>> 0;
      } else if (operation === "DBCC") {
        const op = operands[1];
        if (op?.kind === "PCDISP") jumpTarget = (addr + op.offset + op.disp.baseDisplacement) >>> 0;
      } else if (operation === "JMP" || operation === "JSR") {
        const op = operands[0];
        if (op?.kind === "ABS32" || op?.kind === "ABS16") jumpTarget = op.value >>> 0;
      }
    } catch { /* unknown opcode — keep dc.w fallback */ }
    const hex = Array.from(mem.subarray(0, bytesUsed), (b: number) => b.toString(16).padStart(2, "0")).join(" ");
    instructions.push({ address: addr, hex, text, length: bytesUsed, jumpTarget });
    addr = (addr + bytesUsed) >>> 0;
  }
  return instructions;
}

// Disassemble every function that executed this frame: aggregate exact per-PC hit/cycle counts
// from `samples` (this profiler traces every retired instruction, not statistical sampling),
// resolve each unique PC to its enclosing function's [start, end) via sourceMap + model.symbols,
// then decode client-side from snapshot memory using m68kdecode. Returns [] if chipMem is absent.
export function fetchDisassembly(
  model: IProfileModel,
  samples: InstructionSample[],
  sourceMap: SourceMap,
  chipMem?: Uint8Array,
  slowMem?: Uint8Array,
  fastMem?: Uint8Array,
  fastAddr?: number,
): RawDisassembledFunction[] {
  if (!chipMem) return [];

  const pcStats = new Map<number, { hits: number; cycles: number }>();
  for (const s of samples) {
    const pc = s.stack[0];
    const e = pcStats.get(pc);
    if (e) { e.hits++; e.cycles += s.cycles; }
    else pcStats.set(pc, { hits: 1, cycles: s.cycles });
  }

  const symByName = new Map((model.symbols ?? []).map((s) => [s.name, s]));
  const functions = new Map<number, { name: string; end: number; totalCycles: number }>();
  for (const [pc, stat] of pcStats) {
    const off = sourceMap.findSymbolOffset(pc, true);
    if (!off) continue;
    const sym = symByName.get(off.symbol);
    if (!sym || sym.size <= 0) continue;
    let fn = functions.get(sym.address);
    if (!fn) { fn = { name: sym.name, end: sym.address + sym.size, totalCycles: 0 }; functions.set(sym.address, fn); }
    fn.totalCycles += stat.cycles;
  }

  const ordered = [...functions.entries()].sort((a, b) => b[1].totalCycles - a[1].totalCycles).slice(0, MAX_DISASSEMBLE_FUNCTIONS);

  const out: RawDisassembledFunction[] = [];
  for (const [startAddr, fn] of ordered) {
    const raw = clientDisassembleRange(chipMem, slowMem, startAddr, fn.end, fastMem, fastAddr);
    const instructions: RawDisassembledInstruction[] = raw.map((ins) => {
      const stat = pcStats.get(ins.address);
      return { address: ins.address, hex: ins.hex, text: ins.text, length: ins.length, hits: stat?.hits ?? 0, cycles: stat?.cycles ?? 0, jumpTarget: ins.jumpTarget };
    });
    out.push({ address: startAddr, name: fn.name, instructions });
  }
  return out;
}

// Sentinel depth value the C side emits between consecutive frames in g_wprofBuf.
// Must match WASM_PROFILE_FRAME_MARKER in puae-wasm/puae_debug.c.
const WASM_PROFILE_FRAME_MARKER = 0xFFFFFF01;

// Split a combined multi-frame profile stream (WASM_PROFILE_FRAME_MARKER [marker, frameIdx]
// pairs between each frame's samples) into per-frame arrays.  Returns:
//   perFrame[i]   — decoded InstructionSample[] for frame i
//   startWords[i] — word index of frame i's first record in `words`
//   endWords[i]   — word index just past frame i's last record (= marker index or words.length)
// Used by the multi-frame single-call capture path to slice raw.profile.data per frame.
function splitProfileStream(words: Uint32Array): {
  perFrame: InstructionSample[][];
  startWords: number[];
  endWords: number[];
} {
  const perFrame: InstructionSample[][] = [];
  const startWords: number[] = [];
  const endWords: number[] = [];
  let current: InstructionSample[] = [];
  let frameStart = 0;
  let i = 0;
  while (i < words.length) {
    const depth = words[i]; // peek without consuming
    if (depth === WASM_PROFILE_FRAME_MARKER) {
      perFrame.push(current);
      startWords.push(frameStart);
      endWords.push(i);
      current = [];
      frameStart = i + 2; // skip marker word + frameIdx word
      i += 2;
      continue;
    }
    if (depth === 0 || depth > MAX_DEPTH) break;
    i++; // consume depth word
    if (i + depth + 1 > words.length) break;
    const stack: number[] = [];
    for (let d = 0; d < depth; d++) stack.push(words[i++]);
    const cycles = words[i++];
    current.push({ stack, cycles });
  }
  // Final frame (or the only frame when N=1, which has no markers).
  perFrame.push(current);
  startWords.push(frameStart);
  endWords.push(i);
  return { perFrame, startWords, endWords };
}

// Orchestrates a capture: upload the unwind table, run the profiled frame(s),
// read back the binary stream, decode + aggregate into a call tree. All heavy
// work (symbolication, aggregation) happens here, once, so the webview only ever
// receives the compact tree.
export class ProfilerManager {
  constructor(
    private readonly getClient: () => ProfilerRpcClient | undefined,
    private readonly getSourceMap: () => SourceMap | undefined,
  ) {}

  // All frames from the last capture, retained so the webview "Save" button can
  // serialize frame 0 to a .puaeprofile without re-running the emulator.
  private lastFrames: FrameCapture[] = [];
  // Per-frame raw InstructionSample arrays, parallel to lastFrames. Kept separate from
  // lastFrames because buildRangeModel needs them for arbitrary sub-range combinations
  // without rebuilding entire models (IProfileModel.samples are node IDs, not raw stacks).
  private _frameSamples: InstructionSample[][] = [];
  public getSamples(): readonly InstructionSample[] {
    return this.lastFrames[0] ? (this._lastSamples0 ?? []) : [];
  }
  private _lastSamples0: InstructionSample[] = [];

  public getLastRaw(): RawCapture | undefined {
    return this.lastFrames[0]?.raw;
  }

  // Build a combined model for a sub-range [a, b] of captured frames (inclusive).
  // Called server-side in response to a "computeRange" webview message (shift-click selection).
  public buildRangeModel(range: [number, number]): IProfileModel | null {
    const sourceMap = this.getSourceMap();
    if (!sourceMap) return null;
    const [a, b] = range;
    if (a < 0 || b >= this._frameSamples.length || a > b) return null;
    const samples: InstructionSample[] = [];
    for (let i = a; i <= b; i++) samples.push(...this._frameSamples[i]);
    if (!samples.length) return null;
    const avgCycles = this.lastFrames.slice(a, b + 1).reduce((s, f) => s + f.model.cyclesPerMicroSecond, 0) / (b - a + 1);
    const model = buildProfileModel(samples, sourceMap, avgCycles);
    model.symbols   = this.lastFrames[0]?.model.symbols;
    model.lineTable = this.lastFrames[0]?.model.lineTable;
    model.segments  = this.lastFrames[0]?.model.segments;
    if (this.lastFrames[0]?.raw.disassembly?.length) {
      const reweighted = reweightDisassembly(this.lastFrames[0].raw.disassembly, samples);
      model.disassembly = attachDisassembly(reweighted, sourceMap);
    }
    return model;
  }

  // Capture `numFrames` independent single-frame profiles in sequence, each with its own
  // model and JPEG thumbnail. Returns one FrameCapture per frame; single-frame captures
  // (numFrames=1, the default) return a one-element array for API uniformity.
  public async capture(numFrames = 1): Promise<FrameCapture[]> {
    const rpc = this.getClient();
    if (!rpc) throw new Error("Profiler: no active emulator session — start a debug session first");
    const sourceMap = this.getSourceMap();
    if (!sourceMap) throw new Error("Profiler: no source map (is a program loaded with DWARF info?)");

    const rows = sourceMap.getUnwindRows();
    const table = buildUnwindTable(rows);
    if (table) {
      // C/C++ with DWARF .debug_frame: the emulator unwinds A5/A7 with this table.
      await rpc.sendRpcCommand("profileSetUnwind", {
        data: table.buffer,
        startAddr: table.startAddr,
        endAddr: table.endAddr,
      });
    } else {
      // Assembly / hunk with no DWARF: upload an EMPTY table (which makes the emulator
      // fall back to runtime branch-stack unwinding — JSR/BSR/RTS/RTE tracking) plus the
      // code range, derived from the loaded CODE segment(s), for the in-range sample gate
      // and the branch-stack seeding scan. Segment names are like "0: CODE CHIP".
      const segs = sourceMap.getSegmentsInfo();
      const code = segs.filter((s) => /code/i.test(s.name));
      const ranges = code.length ? code : segs.slice(0, 1);
      if (ranges.length === 0) throw new Error("Profiler: no loaded code segment");
      const startAddr = Math.min(...ranges.map((s) => s.address));
      const endAddr = Math.max(...ranges.map((s) => s.address + s.size));
      await rpc.sendRpcCommand("profileSetUnwind", {
        data: new Uint8Array(0),
        startAddr,
        endAddr,
      });
    }

    const u8 = (d: unknown): Uint8Array => (d instanceof Uint8Array ? d : new Uint8Array((d as ArrayLike<number>) ?? 0));
    // getProfileData/getProfileRegs send their (potentially multi-MB) buffers as a base64
    // string rather than a raw Uint8Array — see rpc.ts's uint8ToBase64 comment: the
    // webview<->extension postMessage bridge flattens TypedArrays into slow per-element
    // array-likes, which dominated the profiler round-trip once a fast-RAM-heavy capture
    // pushed these buffers towards their multi-MB caps.
    const fromBase64 = (s: unknown): Uint8Array => (typeof s === "string" && s.length > 0 ? new Uint8Array(Buffer.from(s, "base64")) : new Uint8Array(0));

    // Explicitly pause the emulator for the whole capture+retrieval sequence below, not just
    // wasm_profile_start()'s own call — the emulator would otherwise resume free-running the
    // instant that call returns (it only restores whatever pause state existed *before* it
    // ran), competing with the render/tick loop for main-thread time throughout the
    // getFramebuffer/getProfileData/etc RPC chain that follows. For CPU/workload combos where a
    // single tick already costs as much or more than one video frame's worth of real time (see
    // the CPU profiler 68020/fast-RAM hang investigation), that contention alone was enough to
    // blow through RPC timeouts on calls with no large payload of their own. Pausing first means
    // wasm_profile_start's own restore-on-exit leaves the emulator paused for the whole
    // retrieval window for free — resumed below (in the finally block) only if it wasn't
    // already paused, so a session already stopped at a breakpoint stays stopped.
    let resumeAfterCapture = false;
    try {
      const { paused } = await rpc.sendRpcCommand<{ paused: boolean }>("isPaused");
      if (!paused) {
        // silent: true — this pause is an internal implementation detail (see
        // the comment above), not a real debugging pause. Without it, the
        // resulting StoppedEvent made VS Code reveal the paused source/
        // disassembly location on every capture, popping the editor in front
        // of the profiler webview the user just opened.
        await rpc.sendRpcCommand("pause", { silent: true });
        resumeAfterCapture = true;
      }
    } catch {
      // unsupported backend — capture proceeds without the pause/resume bracket
    }

    // Capture N frames sequentially — each is one independent single-frame profile with its
    // own DMA grid, register trace, copper trace, and JPEG thumbnail. Copper tracking stays
    // enabled for the whole run and is turned off in the finally block after all frames.
    try {
      await rpc.sendRpcCommand("copperTrackingEnable", { enabled: true });
    } catch {
      // unsupported backend — copper trace just won't appear
    }

    const frames: FrameCapture[] = [];
    const allSamples: InstructionSample[] = []; // accumulated across all frames for combined model
    this._frameSamples = []; // reset per-frame sample store for buildRangeModel
    try {
      if (numFrames === 1) {
        // ── Single-frame path — one startProfiling call, all data fetched immediately ──────
        await rpc.sendRpcCommand("startProfiling", { numFrames: 1 }, 30000);

        // g_rgba_buf holds the frame's pixels after startProfiling returns; grab both the
        // filmstrip thumbnail and the full-res image before anything could overwrite it.
        let thumbnail: RawCapture["thumbnail"] | undefined;
        let fullFrame: RawCapture["fullFrame"] | undefined;
        try {
          const fbRes = await rpc.sendRpcCommand<{ data: Uint8Array; width: number; height: number }>("getFramebuffer", undefined, 30000);
          const fbData = u8(fbRes.data);
          if (fbData.length && fbRes.width > 0 && fbRes.height > 0) {
            thumbnail = { data: fbData, width: fbRes.width, height: fbRes.height };
          }
        } catch (e) {
          console.warn("[profiler] frame 0: thumbnail capture failed:", e);
        }
        try {
          // wasm_profile_start always stores a full-res frame in g_wprofFullFrames[0];
          // batch-encode it via the same OffscreenCanvas path used by multi-frame captures.
          const ffBatch = await rpc.sendRpcCommand<{ data: Uint8Array; width: number; height: number }[]>("getProfileFullFrameBatch", undefined, 30000);
          const ff = ffBatch[0];
          if (ff && u8(ff.data).length && ff.width > 0 && ff.height > 0) {
            fullFrame = { data: u8(ff.data), width: ff.width, height: ff.height };
          }
        } catch (e) {
          console.warn("[profiler] frame 0: full-frame capture failed:", e);
        }

        // Same generous budget as startProfiling — the buffer this ships is a per-instruction
        // sample stream whose size scales with in-range instruction count, which unthrottled
        // fast-RAM code (and 68020's higher retirement rate even from chip RAM) can push large
        // enough that the postMessage transfer itself, not just the capture, takes a while.
        const res = await rpc.sendRpcCommand<{
          dataBase64: string;
          start: number;
          end: number;
          total: number;
          inRange: number;
          frameCycles?: number;
          isPAL?: boolean;
        }>("getProfileData", undefined, 30000);

        const raw: RawCapture = {
          profile: {
            data: fromBase64(res.dataBase64),
            start: res.start,
            end: res.end,
            total: res.total,
            inRange: res.inRange,
            frameCycles: res.frameCycles ?? 0,
            isPAL: res.isPAL ?? true,
          },
          thumbnail,
          fullFrame,
        };

        try {
          const regsRes = await rpc.sendRpcCommand<{ dataBase64: string }>("getProfileRegs", undefined, 30000);
          const regsBytes = fromBase64(regsRes.dataBase64);
          if (regsBytes.length) raw.registers = regsBytes;
        } catch (e) {
          console.warn("[profiler] frame 0: register trace failed:", e);
        }

        try {
          const dmaRes = await rpc.sendRpcCommand<{ data: Uint8Array }>("getDmaData", undefined, 30000);
          const dmaBytes = u8(dmaRes.data);
          if (dmaBytes.length) {
            raw.dma = dmaBytes;
            const snap = await rpc.sendRpcCommand<{ chip: Uint8Array; slow: Uint8Array; fast?: Uint8Array; fastAddr?: number; custom: Uint8Array; agaColors?: Uint8Array }>("getDmaSnapshot", undefined, 30000);
            raw.snapshot = { chip: u8(snap.chip), slow: u8(snap.slow), fast: snap.fast && u8(snap.fast), fastAddr: snap.fastAddr, custom: u8(snap.custom), agaColors: snap.agaColors && u8(snap.agaColors) };
            const eventsRes = await rpc.sendRpcCommand<{ data: Uint8Array }>("getDmaEvents", undefined, 30000);
            const eventsBytes = u8(eventsRes.data);
            if (eventsBytes.length) raw.dmaEvents = eventsBytes;
          }
        } catch (e) {
          console.warn("[profiler] frame 0: DMA capture failed:", e);
        }

        try {
          const copperRes = await rpc.sendRpcCommand<{ data: Uint8Array }>("getCopperData", undefined, 30000);
          const copperBytes = u8(copperRes.data);
          if (copperBytes.length) raw.copper = copperBytes;
        } catch (e) {
          console.warn("[profiler] frame 0: copper trace failed:", e);
        }

        const { model, samples } = buildModelFromCapture(raw, sourceMap);

        if (samples.length === 0) {
          const range = `[0x${(res.start >>> 0).toString(16)}, 0x${(res.end >>> 0).toString(16)})`;
          const hint =
            res.total === 0
              ? "The emulator executed no instructions in the captured frame."
              : res.inRange === 0
                ? `None of the ${res.total} executed instructions were inside your program ${range} — it may be idle/finished or running OS code. Try capturing while the program is actively running.`
                : "Instructions ran in range but produced no stack samples (unwind issue).";
          throw new Error(`No profile samples captured. ${hint}`);
        }

        allSamples.push(...samples);
        this._frameSamples[0] = samples;
        this._lastSamples0 = samples;

        raw.disassembly = fetchDisassembly(model, samples, sourceMap, raw.snapshot?.chip, raw.snapshot?.slow, raw.snapshot?.fast, raw.snapshot?.fastAddr);
        if (raw.disassembly.length) model.disassembly = attachDisassembly(raw.disassembly, sourceMap);

        frames.push({ model, raw });
      } else {
        // ── Multi-frame single-call path — all N frames in one wasm call ──────────────────
        // The profile stream contains WASM_PROFILE_FRAME_MARKER sentinels between frames.
        // The DMA grid holds only the last frame (double-buffer toggle limitation — only
        // one frame's DMA is accessible at a time via puae_dma_serialize).
        await rpc.sendRpcCommand("startProfiling", { numFrames }, 30000 * numFrames);

        // All N frame thumbnails encoded in parallel in one round-trip.
        let thumbBatch: { data: Uint8Array; width: number; height: number }[] = [];
        try {
          thumbBatch = await rpc.sendRpcCommand<{ data: Uint8Array; width: number; height: number }[]>("getProfileThumbBatch", undefined, 30000 * numFrames);
        } catch (e) {
          console.warn("[profiler] thumbnail batch capture failed:", e);
        }

        // Full-resolution frames for hover-to-enlarge, encoded in parallel alongside thumbnails.
        let fullFrameBatch: { data: Uint8Array; width: number; height: number }[] = [];
        try {
          fullFrameBatch = await rpc.sendRpcCommand<{ data: Uint8Array; width: number; height: number }[]>("getProfileFullFrameBatch", undefined, 30000 * numFrames);
        } catch (e) {
          console.warn("[profiler] full-frame batch capture failed:", e);
        }

        // Same generous, numFrames-scaled budget as startProfiling — this buffer holds all N
        // frames' per-instruction sample streams concatenated, so its transfer time scales
        // with numFrames just like the capture itself.
        const res = await rpc.sendRpcCommand<{
          dataBase64: string;
          start: number;
          end: number;
          total: number;
          inRange: number;
          frameCycles?: number;
          isPAL?: boolean;
        }>("getProfileData", undefined, 30000 * numFrames);

        // Registers: only frame 0 has register data (C disables g_wprofRegEnabled at the first
        // frame marker, so the 65k-sample cap can't block subsequent frames' profile recording).
        let allRegsBytes: Uint8Array = new Uint8Array(0);
        try {
          const regsRes = await rpc.sendRpcCommand<{ dataBase64: string }>("getProfileRegs", undefined, 30000 * numFrames);
          allRegsBytes = fromBase64(regsRes.dataBase64);
        } catch (e) {
          console.warn("[profiler] register trace failed:", e);
        }

        // Per-frame DMA grids — serialized in C right after each retro_run() while the
        // toggle buffer still holds that frame's data.  These are fast fetches (no emulation,
        // just HEAPU8 slices): each 568KB grid transfers in ~454ms at 800ms/MB, so for
        // N=10 frames the total DMA transfer is ~4.5s vs. ~4.5s in the old N-loop — same
        // total data volume, but we've already saved the snapshot + register round-trips.
        const perFrameDmaBytes: (Uint8Array | undefined)[] = new Array(numFrames).fill(undefined);
        const perFrameEvtBytes: (Uint8Array | undefined)[] = new Array(numFrames).fill(undefined);
        const perFrameCopperBytes: (Uint8Array | undefined)[] = new Array(numFrames).fill(undefined);
        try {
          for (let fi = 0; fi < numFrames; fi++) {
            const dmaRes = await rpc.sendRpcCommand<{ data: Uint8Array }>("getDmaFrame", { frameIdx: fi }, 30000);
            const db = u8(dmaRes.data);
            if (db.length) perFrameDmaBytes[fi] = db;
            const evtRes = await rpc.sendRpcCommand<{ data: Uint8Array }>("getDmaEventsFrame", { frameIdx: fi }, 30000);
            const eb = u8(evtRes.data);
            if (eb.length) perFrameEvtBytes[fi] = eb;
            try {
              const copperRes = await rpc.sendRpcCommand<{ data: Uint8Array }>("getCopperFrame", { frameIdx: fi }, 30000);
              const cb = u8(copperRes.data);
              if (cb.length) perFrameCopperBytes[fi] = cb;
            } catch {
              // unsupported backend or no copper tracking — copper trace just won't appear
            }
          }
        } catch (e) {
          console.warn("[profiler] per-frame DMA capture failed:", e);
        }

        // Snapshot captured at end-of-capture state (last frame) — used for memory
        // reconstruction; only attached to the last frame to avoid duplicating 2.5MB per frame.
        let snapshotRaw: { chip: Uint8Array; slow: Uint8Array; fast?: Uint8Array; fastAddr?: number; custom: Uint8Array; agaColors?: Uint8Array } | undefined;
        try {
          if (perFrameDmaBytes[numFrames - 1]) {
            const snap = await rpc.sendRpcCommand<{ chip: Uint8Array; slow: Uint8Array; fast?: Uint8Array; fastAddr?: number; custom: Uint8Array; agaColors?: Uint8Array }>("getDmaSnapshot", undefined, 30000);
            snapshotRaw = { chip: u8(snap.chip), slow: u8(snap.slow), fast: snap.fast && u8(snap.fast), fastAddr: snap.fastAddr, custom: u8(snap.custom), agaColors: snap.agaColors && u8(snap.agaColors) };
          }
        } catch (e) {
          console.warn("[profiler] snapshot fetch failed:", e);
        }

        // Split the combined stream at WASM_PROFILE_FRAME_MARKER boundaries.
        const profileBytes = fromBase64(res.dataBase64);
        const words = new Uint32Array(profileBytes.buffer, profileBytes.byteOffset, profileBytes.byteLength >>> 2);
        const { perFrame: perFrameSamples, startWords, endWords } = splitProfileStream(words);

        const frameUs = (res.isPAL ?? true) ? 20000 : 1_000_000 / 60;
        const cyclesPerMicroSecond = (res.frameCycles ?? 0) > 0 ? (res.frameCycles!) / frameUs : 7.09379;

        // Validate frame 0 has samples before spending time building the rest.
        if ((perFrameSamples[0]?.length ?? 0) === 0) {
          const range = `[0x${(res.start >>> 0).toString(16)}, 0x${(res.end >>> 0).toString(16)})`;
          const hint =
            res.total === 0
              ? "The emulator executed no instructions in the captured frame."
              : res.inRange === 0
                ? `None of the ${res.total} executed instructions were inside your program ${range} — it may be idle/finished or running OS code. Try capturing while the program is actively running.`
                : "Instructions ran in range but produced no stack samples (unwind issue).";
          throw new Error(`No profile samples captured. ${hint}`);
        }

        const totalFrames = perFrameSamples.length;
        const lastFrameIdx = totalFrames - 1;

        for (let fi = 0; fi < totalFrames; fi++) {
          const samples = perFrameSamples[fi];
          allSamples.push(...samples);
          this._frameSamples[fi] = samples;

          const isLastFrame = fi === lastFrameIdx;

          // Slice of the combined stream bytes that belongs to this frame, so raw.profile.data
          // encodes correctly when saved to a .puaeprofile (frame 0 only is ever saved, but
          // keep it correct for all frames).
          const frameProfileBytes = profileBytes.slice(startWords[fi] * 4, endWords[fi] * 4);

          const thumbEntry = thumbBatch[fi];
          const thumbnail: RawCapture["thumbnail"] | undefined =
            thumbEntry && u8(thumbEntry.data).length > 0
              ? { data: u8(thumbEntry.data), width: thumbEntry.width, height: thumbEntry.height }
              : undefined;

          const ffEntry = fullFrameBatch[fi];
          const fullFrame: RawCapture["fullFrame"] | undefined =
            ffEntry && u8(ffEntry.data).length > 0
              ? { data: u8(ffEntry.data), width: ffEntry.width, height: ffEntry.height }
              : undefined;

          const raw: RawCapture = {
            profile: {
              data: frameProfileBytes,
              start: res.start,
              end: res.end,
              total: res.total,
              inRange: res.inRange,
              frameCycles: res.frameCycles ?? 0,
              isPAL: res.isPAL ?? true,
            },
            // Every frame has its own DMA grid and copper trace (serialized in C after each retro_run()).
            dma: perFrameDmaBytes[fi],
            dmaEvents: perFrameEvtBytes[fi],
            copper: perFrameCopperBytes[fi],
            // Snapshot (2.5MB) only on the last frame — memory reconstruction baseline is
            // end-of-capture state; correct for the last frame, approximate for earlier ones.
            snapshot: isLastFrame ? snapshotRaw : undefined,
            // Registers: only frame 0 has data in the buffer.
            registers: fi === 0 && allRegsBytes.length > 0 ? allRegsBytes : undefined,
            thumbnail,
            fullFrame,
          };

          const model = buildProfileModel(samples, sourceMap, cyclesPerMicroSecond);
          model.symbols = buildSymbolList(sourceMap);
          model.lineTable = sourceMap.getLineTable().map((e): ILineTableEntry => ({ address: e.address, file: e.path, line: e.line }));
          model.segments = sourceMap.getSegmentsInfo().map((s): ISegmentRange => ({ address: s.address, size: s.size }));

          if (raw.dma) {
            const dma = decodeDmaGrid(raw.dma);
            if (dma) {
              model.dma = dma;
              if (raw.snapshot) {
                model.dmaSnapshot = {
                  chip: raw.snapshot.chip,
                  slow: raw.snapshot.slow,
                  custom: decodeCustomRegs(raw.snapshot.custom),
                  agaColors: decodeAgaColors(raw.snapshot.agaColors),
                };
              }
              if (raw.dmaEvents) {
                const events = decodeDmaEvents(raw.dmaEvents);
                if (events && events.length === dma.owner.length) dma.events = events;
              }
            }
          }
          if (raw.copper) model.copper = decodeCopperRecords(raw.copper);
          if (raw.registers) {
            const decoded = decodeRegisterTrace(raw.registers);
            const wordsNeeded = model.pcs.length * REG_COUNT;
            model.registers = decoded.length > wordsNeeded ? decoded.subarray(0, wordsNeeded) : decoded;
          }

          if (fi === 0) {
            raw.disassembly = fetchDisassembly(model, samples, sourceMap, snapshotRaw?.chip, snapshotRaw?.slow, snapshotRaw?.fast, snapshotRaw?.fastAddr);
            if (raw.disassembly.length) model.disassembly = attachDisassembly(raw.disassembly, sourceMap);
            this._lastSamples0 = samples;
          } else if (frames[0].raw.disassembly?.length) {
            raw.disassembly = reweightDisassembly(frames[0].raw.disassembly, samples);
            model.disassembly = attachDisassembly(raw.disassembly, sourceMap);
          }

          frames.push({ model, raw });
        }
      }
    } finally {
      try {
        await rpc.sendRpcCommand("copperTrackingEnable", { enabled: false });
      } catch {
        // unsupported — no-op
      }
      if (resumeAfterCapture) {
        try {
          await rpc.sendRpcCommand("run", { silent: true }); // matches the silent pause above
        } catch {
          // unsupported/disconnected — best-effort resume
        }
      }
    }

    // For multi-frame captures, build one combined model by re-running buildProfileModel on all
    // frames' InstructionSamples concatenated. This gives correct aggregate node/location times
    // and a single flame-graph timeline spanning the full capture. Can't be done in the webview
    // because IProfileModel.samples holds call-tree node IDs local to each model's own nodes[].
    if (numFrames > 1 && frames.length > 0) {
      const avgCycles = frames.reduce((s, f) => s + f.model.cyclesPerMicroSecond, 0) / frames.length;
      const combined = buildProfileModel(allSamples, sourceMap, avgCycles);
      // Session-constant metadata lives on frame 0.
      combined.symbols   = frames[0].model.symbols;
      combined.lineTable = frames[0].model.lineTable;
      combined.segments  = frames[0].model.segments;
      if (frames[0].raw.disassembly?.length) {
        const reweighted = reweightDisassembly(frames[0].raw.disassembly, allSamples);
        combined.disassembly = attachDisassembly(reweighted, sourceMap);
      }
      frames[0] = { ...frames[0], combined };
    }

    this.lastFrames = frames;
    return frames;
  }
}
