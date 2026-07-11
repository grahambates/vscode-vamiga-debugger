// Shared boot/render-loop logic for the PUAE wasm backend, used by both
// index.html (the clean webview UI) and debug.html (manual test/debug UI).
// Anything that touches the debug-only DOM (#debug, #debugG1, #debugG2 etc.)
// lives in debug.html instead — main() only assumes #screen exists;
// #status is optional (used for boot/fps diagnostics if present).

import { setupRpcDispatcher, getCurrentStopMessage, tryExec, getCurrentProcess, isExecReady } from "./rpc";
import { installDmaHoverTooltip, handleDmaHoverMessage } from "./dmaHover";
import { installMouseCapture } from "./mouseCapture";
import { installKeyboardCapture } from "./keyboardCapture";
import { DmaRecordType } from "../../shared/profilerTypes";
import type { PuaeModule } from "./types";

// The Amiga's PAL frame rate — both the render loop's due-frames accounting
// and its driving tick-worker interval are derived from this. Not exactly 50:
// the core's own retro_get_system_av_info() reports 49.92041015625 (PAL's
// true vertical refresh rate, from the chipset's line/cycle timing — this
// codebase only ever runs PAL, no NTSC option exists). Using a rounded 50
// here made the JS-side scheduler tick ~0.16% faster than the audio the core
// actually generates per real second, with no feedback to correct it — audio
// production slowly outran consumption, filling the worklet's ring buffer
// until it overflowed (an audible click), no matter how big the buffer was.
const PAL_FPS = 49.92041015625;

// In warp mode, run as many ticks as fit in this time budget per tick-worker
// callback (which itself fires every 1000/PAL_FPS ms), leaving headroom in
// each callback for rendering/audio/RPC handling.
const WARP_TICK_BUDGET_MS = 15;

// Caps how many emulated frames of "due" backlog frame()'s catch-up loop will
// ever try to replay after a long main-thread stall (e.g. a profiler capture's
// synchronous wasm_profile_start(), which can legitimately take tens of
// seconds for CPU/workload combinations where a lot of instructions retire
// per profiled frame — see the CPU profiler "purely fast RAM"/68020 hang
// investigation). emuClockMs keeps accumulating real elapsed time during such
// a stall with no ticks actually running, so the very next frame() call can
// see a backlog of 1000+ "due" frames. Without a cap, the catch-up loop's
// per-callback time budget (WARP_TICK_BUDGET_MS) means repaying that backlog
// takes as long in real time as it took to accrue — and if a single tick ever
// costs as much or more than one callback interval (1000/PAL_FPS, ~20ms; true
// for the same slow combinations that created the backlog), the backlog can
// never be repaid at all, permanently monopolizing the main thread and
// starving the RPC message queue that a profiler capture's own follow-up
// calls (getFramebuffer, getProfileData, ...) are waiting in. Beyond this
// many frames, excess backlog is simply dropped (same "snap forward, don't
// replay" behavior frame() already uses while paused) rather than replayed —
// a handful of skipped video frames after a long stall is imperceptible.
const MAX_CATCHUP_FRAMES = 10;

// How often to take a periodic full-state checkpoint (rpc.pushSnapshot())
// during a free-run, for stepBack/continueReverse — one per second of
// emulated time. Rounded; doesn't need PAL_FPS's precision.
const CHECKPOINT_INTERVAL_FRAMES = Math.round(PAL_FPS);

// Register names: D0-D7, A0-A7, SR, PC — order matches e9k_debug_read_regs().
export const REG_NAMES = [
  "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7",
  "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7(SP)",
  "SR", "PC",
];

async function fetchBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// Starts a Worker whose only job is to call back at a steady interval, even
// when the page is in a hidden/background tab (where requestAnimationFrame
// and main-thread setInterval/setTimeout get throttled). Built from an
// inline blob so it works under the webview's CSP without a separate file.
function startTickWorker(onTick: (ts: number) => void, intervalMs: number): Worker {
  const workerScript = `
    let intervalId;
    self.onmessage = (event) => {
      if (event.data.command === 'start' && !intervalId) {
        intervalId = setInterval(
          () => postMessage(performance.now()),
          event.data.intervalMs,
        );
      }
    };
  `;
  const blob = new Blob([workerScript], { type: "application/javascript" });
  const worker = new Worker(URL.createObjectURL(blob));
  // Use the main thread's performance.now() rather than the Worker's timestamp.
  // When VS Code delays the main thread, Worker messages queue up with stale
  // Worker-clock timestamps 20ms apart; processing them with those timestamps
  // causes back-to-back ticks (burst renders). Using the main-thread clock
  // means queued messages all see nearly the same real time, so the dueFrames
  // guard skips duplicates instead of firing them all.
  worker.onmessage = () => onTick(performance.now());
  worker.postMessage({ command: "start", intervalMs });
  return worker;
}

export interface MainConfig {
  wasmLocateFile?: (path: string) => string;
  romUrl?: string;
  extraConfigB64?: string;
  programB64?: string;
  // Base64-encoded JSON array of HardDriveEntry (see puaeEmulator.ts's walkHardDrive) —
  // a walked host directory to replay into DH0:'s MEMFS mount verbatim, taking over from
  // programB64's auto-generated single-exe disk when set (PuaeEmulator never sets both).
  hardDriveManifestB64?: string;
  // Basename of the launch config's `program` — what getCurrentProcess() polling matches
  // the eventual CLI process against, regardless of whether DH0: came from programB64 or
  // hardDriveManifestB64. Falls back to "file" (the legacy hardcoded name) if unset, for
  // debug.html and any other caller that doesn't pass it.
  expectedProcessName?: string;
  audioWorkletUrl?: string;
  // Called once with the wasm module after boot+warm-up, before the RPC
  // bridge is wired up — debug.html uses this to install its debug UI.
  onModuleReady?: (M: PuaeModule) => void;
  // Called with the wasm module whenever the render loop's free-run hits a
  // breakpoint/watchpoint — debug.html uses this to refresh its register/
  // disassembly/callstack views.
  onBreakpoint?: (M: PuaeModule) => void;
}

declare global {
  var drawCurrentFrame: (() => void) | undefined;
}

// createPuaeModule is a global set by puae.js (Emscripten MODULARIZE=1 UMD output)
export async function main(config: MainConfig = {}): Promise<void> {
  const {
    wasmLocateFile,
    romUrl = "./kick34005.A500",
    extraConfigB64 = "",
    programB64 = "",
    hardDriveManifestB64 = "",
    expectedProcessName = "file",
    audioWorkletUrl = "./puae_audioprocessor.js",
    onModuleReady,
    onBreakpoint,
  } = config;

  // True for any non-fastLoad boot that mounts DH0: — either the single-exe disk
  // (programB64) or a mounted host directory (hardDriveManifestB64), whichever
  // PuaeEmulator's getHtmlForWebview set (never both — hardDrivePath takes over
  // entirely when set). Used below wherever the code previously gated purely on
  // "is this a non-fastLoad/DH0: boot" via programB64 alone.
  const usesDh0 = !!(programB64 || hardDriveManifestB64);

  // Hoisted so the render loop's frame() (defined later in this scope) can
  // post 'stopped' emulator-state messages on a breakpoint/watchpoint hit
  // during free-run — only set inside the VS Code webview, see below.
  let vscode: { postMessage: (msg: unknown) => void } | undefined;
  // Hoisted alongside vscode so frame() can take periodic checkpoints via
  // rpc.pushSnapshot() — also only set inside the VS Code webview.
  let rpc: ReturnType<typeof setupRpcDispatcher> | undefined;

  // #status is optional — index.html (the panel view) omits it; debug.html
  // keeps it for boot/fps diagnostics.
  const status = document.getElementById("status");
  function log(msg: string): void {
    if (status) status.textContent = msg;
  }

  log("Initialising wasm module…");
  const M = await createPuaeModule(wasmLocateFile ? { locateFile: wasmLocateFile } : undefined);
  log("Module ready — fetching ROM…");

  M.FS.mkdir("/uae_system");
  // Write Kickstart ROM into the virtual filesystem.
  // When romUrl is empty, skip this — frontend_shim detects the missing file
  // and tells PUAE to use its built-in AROS ROM instead.
  if (romUrl) {
    const romData = await fetchBytes(romUrl);
    M.FS.writeFile("/uae_system/kick34005.A500", romData);
    log(`ROM: ${romData.length} bytes → /uae_system/kick34005.A500`);
  } else {
    log("No ROM provided — using built-in AROS ROM");
  }

  // Extra PUAE config (.uae key=value lines), built by
  // PuaeEmulator.getHtmlForWebview from OpenOptions.configFilePath,
  // chipRam/slowRam/fastRam/cpuRevision and emulatorOptions.puae. Empty by
  // default — retro_create_config() only reads this file if it exists.
  if (extraConfigB64) {
    const extraConfig = atob(extraConfigB64);
    M.FS.writeFile("/uae_system/puae_libretro_global.uae", extraConfig);
    log(`Config: ${extraConfig.length} bytes → /uae_system/puae_libretro_global.uae`);
  }

  // Non-fastLoad boot: populate a MEMFS directory that the "filesystem=rw,dh0:..."
  // line above (buildExtraConfig) mounts as a bootable DH0: hard disk. AmigaOS's
  // uaehf.device autoconfigures this — no ADF/bootblock/OFS image needed. The
  // render loop below polls for the resulting CLI process (expectedProcessName).
  if (hardDriveManifestB64) {
    // OpenOptions.hardDrivePath: a walked host directory (puaeEmulator.ts's
    // walkHardDrive), replayed verbatim — the directory is authoritative, so
    // unlike the programB64 branch below, nothing is synthesized here (no
    // auto-generated startup-sequence; the directory must already have one).
    const manifest = JSON.parse(atob(hardDriveManifestB64)) as
      { path: string; dir: boolean; dataB64?: string }[];
    M.FS.mkdir("/uae_system/dh0");
    let fileCount = 0, byteCount = 0;
    for (const entry of manifest) {
      const target = `/uae_system/dh0/${entry.path}`;
      if (entry.dir) {
        M.FS.mkdir(target);
      } else {
        const data = Uint8Array.from(atob(entry.dataB64 ?? ""), c => c.charCodeAt(0));
        M.FS.writeFile(target, data);
        fileCount++;
        byteCount += data.length;
      }
    }
    log(`Hard drive: ${fileCount} file(s), ${byteCount} bytes → /uae_system/dh0`);
  } else if (programB64) {
    // OpenOptions.programPath (auto-generated single-exe disk, the default when
    // hardDrivePath isn't set): write the exe under its own basename
    // (expectedProcessName) plus a minimal startup-sequence that runs it.
    const programData = Uint8Array.from(atob(programB64), c => c.charCodeAt(0));
    M.FS.mkdir("/uae_system/dh0");
    M.FS.writeFile(`/uae_system/dh0/${expectedProcessName}`, programData);
    M.FS.mkdir("/uae_system/dh0/s");
    M.FS.writeFile("/uae_system/dh0/s/startup-sequence", expectedProcessName);
    log(`Program: ${programData.length} bytes → /uae_system/dh0/${expectedProcessName}`);
  }

  // Boot the core with no disk inserted. fastLoad injects a standalone
  // program directly into memory once Kickstart has booted far enough to
  // allocate it (see the warm-up below) — there's no DOS process to load
  // a disk-based program from, and a disk would only race fastLoad's memory
  // injection with the disk's own boot code. Non-fastLoad programs (above)
  // are loaded via DH0:, not a disk image, so this is still '' either way.
  const wasm_boot = M.cwrap("wasm_boot", "number", ["string"]) as (s: string) => number;
  log("Calling wasm_boot…");
  const ok = wasm_boot("");
  if (!ok) { log("wasm_boot FAILED — check console"); return; }

  // [vscode-puae-debugger mem protect] fastLoad starts this in the
  // warm-up loop just below, before frame() ever runs; non-fastLoad starts
  // it from frame() instead, polling from frame 0 — see both below.
  let memProtectTrackingStarted = false;

  if (!usesDh0) {
    // Warm-up: tick until AmigaOS is ready for fastLoad memory injection —
    // mirrors vAmiga_ui.js's tryExec condition (AllocMem LVO is jmp, GfxBase
    // set, CPU out of supervisor mode). 1000 ticks is a generous safety
    // ceiling. Kickstart needs ~150 ticks to clear CIA-A OVL and initialise
    // exec.library's allocator (see puae-wasm/test_g1.mjs). Stopping exactly
    // when ready is faster and more robust than a fixed count.
    //
    // For non-fastLoad (usesDh0), this warm-up is skipped — the render
    // loop runs from frame 0 so tryExec/getCurrentProcess polling (below) can
    // observe AmigaOS booting from DH0: and running the startup-sequence.
    log("Waiting for exec.library to initialise…");
    // [vscode-puae-debugger mem protect] Poll every tick, not just once at
    // the end — the C side validates execBase itself and no-ops until ready,
    // so this starts the AllocMem/FreeMem watch as soon as exec.library
    // initializes (well before isExecReady's GfxBase+signature heuristic),
    // catching Kickstart's own boot-time allocations too.
    for (let i = 0; !isExecReady(M) && i < 1000; i++) {
      M._wasm_tick();
      if (!memProtectTrackingStarted) {
        memProtectTrackingStarted = !!M._wasm_memprotect_start_tracking();
      }
    }
    if (!memProtectTrackingStarted) {
      memProtectTrackingStarted = !!M._wasm_memprotect_start_tracking();
    }
    // [vscode-puae-debugger mem protect] GfxBase is confirmed set here
    // (isExecReady checked it), so its own library list is guaranteed to be
    // populated — safe to walk now, unlike at the earlier raw-execBase
    // tracking-start point above (see ami_debug.c's
    // e9k_debug_memprotect_seed_libraries).
    if (isExecReady(M)) M._wasm_memprotect_seed_libraries();
  }

  // -------- audio setup --------
  let workletNode: AudioWorkletNode | null = null;
  let audioCtx: AudioContext | null = null;
  let gain: GainNode | null = null; // hoisted so the speed/warp controls can mute audio
  let audioMuted = true; // starts muted — the toggle button is the explicit opt-in

  // PUAE always outputs at 44100 Hz; AudioContext may be at a different rate (e.g. 48000).
  // Resample with linear interpolation so the worklet's ring buffer stays balanced —
  // without this, a 48000 Hz context drains faster than we'd otherwise push, emptying
  // the buffer every cycle.
  //
  // The resampler is *stateful*: it carries a fractional read position and the last
  // source sample across chunks. Resampling each tick's chunk (~883 samples, one PAL
  // frame at 44100/49.92041015625) in isolation (mapping it to [0, dstN-1] on its own)
  // put a one-sample spacing discontinuity at every chunk boundary — an audible buzz/
  // jitter on any context whose rate isn't exactly 44100. Walking one continuous phase
  // across chunks removes it.
  const audioPuaeRate = 44100;
  let audioCtxRate = 44100;
  let audioResampleFrac = 0; // fractional distance past audioPrevL/R, in [0,1)
  let audioPrevL = 0, audioPrevR = 0; // last source sample of the previous chunk

  function resetResampler(): void {
    audioResampleFrac = 0;
    audioPrevL = 0;
    audioPrevR = 0;
  }

  function resampleChunk(srcL: Float32Array, srcR: Float32Array, srcN: number): { l: Float32Array; r: Float32Array } {
    // Pass-through when rates match: copy out (callers transfer the buffer).
    if (audioCtxRate === audioPuaeRate) {
      return { l: srcL.slice(0, srcN), r: srcR.slice(0, srcN) };
    }
    const step = audioPuaeRate / audioCtxRate; // source samples advanced per output sample
    const l = new Float32Array(Math.ceil(srcN / step) + 2);
    const r = new Float32Array(l.length);
    let frac = audioResampleFrac;
    let prevL = audioPrevL, prevR = audioPrevR;
    let o = 0;
    for (let i = 0; i < srcN; i++) {
      const curL = srcL[i], curR = srcR[i];
      // Emit every output sample falling between prevSample and curSample.
      while (frac < 1) {
        l[o] = prevL + frac * (curL - prevL);
        r[o] = prevR + frac * (curR - prevR);
        o++;
        frac += step;
      }
      frac -= 1;
      prevL = curL; prevR = curR;
    }
    audioResampleFrac = frac;
    audioPrevL = prevL; audioPrevR = prevR;
    return { l: l.subarray(0, o), r: r.subarray(0, o) };
  }

  function pushAccumToWorklet(): void {
    if (!workletNode) return;
    const n = M._wasm_get_audio_accum_count();
    if (n <= 0) return;
    if (!audioCtx || audioCtx.state !== "running") {
      // Nothing is draining the worklet right now (context suspended — e.g.
      // autoplay policy before the user unmutes) — discard instead of
      // building a backlog that would otherwise dump out as a stale,
      // overflow-glitched burst the moment playback resumes.
      M._wasm_reset_audio_accum();
      return;
    }
    const ptrL = M._wasm_get_audio_accum_L();
    const ptrR = M._wasm_get_audio_accum_R();
    // Views into wasm memory — read before resetting accumulator.
    const rawL = new Float32Array(M.HEAPF32.buffer, ptrL, n);
    const rawR = new Float32Array(M.HEAPF32.buffer, ptrR, n);
    const { l, r } = resampleChunk(rawL, rawR, n);
    M._wasm_reset_audio_accum();
    workletNode.port.postMessage({ l, r }, [l.buffer, r.buffer]);
  }

  async function startAudio(): Promise<void> {
    // Discard any audio that built up before now — we don't want to hear a
    // burst of old audio when the worklet starts.
    M._wasm_reset_audio_accum();

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRate = audioCtx.sampleRate;
    // If the context gets re-suspended (e.g. tab hidden), resume it
    // automatically when the user next clicks the audio button — no blanket
    // document listeners needed since the button is the explicit gesture.
    let audioWasRunning = audioCtx.state === "running";
    audioCtx.onstatechange = () => {
      const running = audioCtx!.state === "running";
      if (running && !audioWasRunning) {
        // Just started draining again after being suspended (e.g. autoplay
        // policy before the first unmute, or a tab-hidden re-suspend) —
        // discard whatever piled up in both the wasm accumulator and the
        // worklet's ring buffer while nothing was consuming it. Without
        // this, resuming dumps a backlog of stale, overflow-truncated audio
        // all at once — an audible jump.
        M._wasm_reset_audio_accum();
        resetResampler();
        workletNode?.port.postMessage({ reset: true });
      }
      audioWasRunning = running;
      if (!running && !audioMuted) audioCtx!.resume();
    };
    await audioCtx.audioWorklet.addModule(audioWorkletUrl);
    workletNode = new AudioWorkletNode(audioCtx, "puae-audio-processor", {
      outputChannelCount: [2], numberOfInputs: 0, numberOfOutputs: 1,
    });
    gain = audioCtx.createGain();
    applyAudioMute();
    workletNode.connect(gain);
    gain.connect(audioCtx.destination);

    // Pre-fill the ring buffer with ~200ms of audio before the worklet starts
    // draining it, so initial message-delivery latency and scheduling jitter
    // don't immediately underrun. This cushion is what the catch-up logic in
    // frame() (uncapped, time-budgeted tick recovery) restores after a
    // main-thread stall — see the comment there.
    resetResampler();
    const PREFILL_FRAMES = 10;
    for (let i = 0; i < PREFILL_FRAMES; i++) M._wasm_tick();
    emuFrames += PREFILL_FRAMES;
    pushAccumToWorklet();
  }
  // -------------------------------------------------------

  if (onModuleReady) onModuleReady(M);

  // RPC bridge (Stage G3) — only present inside the VS Code webview.
  if (typeof acquireVsCodeApi === "function") {
    vscode = acquireVsCodeApi();
    rpc = setupRpcDispatcher(M, (msg) => vscode!.postMessage(msg));
    window.addEventListener("message", (event) => rpc!.handleMessage(event.data));
    // Handles symbolizeAddress replies for the DMA hover tooltip's
    // source-location lookup (see installDmaHoverTooltip below) — a
    // separate listener since these aren't {command,args}-shaped RPC
    // messages, just ignored by rpc.handleMessage.
    window.addEventListener("message", (event) => handleDmaHoverMessage(event.data));
    // Tells PuaeEmulator the wasm module is ready, so it can fetch and cache
    // getMemoryInfo() — mirrors the vAmiga emulator project's own webview-ready handshake.
    vscode.postMessage({ type: "exec-ready" });
  }

  log("Boot OK — starting render loop");

  // ---------- render loop ----------
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;

  // Drive at exactly 50 Hz PAL using a cumulative due-frames counter so the tick
  // fires at the right wall-clock time regardless of the display refresh rate.
  let emuFrames = 0; // total emulation frames run so far
  // When audio is running at normal speed, pace emulation off the AudioContext's
  // own clock instead of the system clock (performance.now()). The two clocks
  // run at very slightly different rates (ordinary audio-hardware clock drift),
  // so pacing off the system clock while the worklet drains at the hardware
  // rate makes production slowly outrun consumption until the ring buffer
  // fills and starts dropping samples — an audible click each time it
  // overflows. Tying production to the same clock that drives consumption
  // removes the drift instead of just buffering around it. null means "not
  // currently using the audio clock" (audio not yet running, or warp/non-1x
  // speed, which mute audio and must stay on the system clock).
  let lastAudioClockS: number | null = null;
  let lastCheckpointFrame = 0; // emuFrames at the last periodic rpc.pushSnapshot()
  let fpsTime = 0;
  let fpsCnt = 0;
  let imgData: ImageData | null = null; // cached ImageData — owns its own ArrayBuffer
  // wasm_get_frame_count() as of the last canvas redraw — lets us notice the
  // framebuffer changed while paused (e.g. stepBack/continueReverse/
  // stepBackFrame's landing replay renders a frame via
  // wasm_replay_instructions_video) and redraw even though emulation isn't
  // advancing.
  let lastFbFrameCount = -1;

  // Called by rpc.ts's async continueReverse to paint the current wasm
  // framebuffer to the canvas between checkpoint intervals.
  globalThis.drawCurrentFrame = () => {
    const w = M._wasm_get_fb_width();
    const h = M._wasm_get_fb_height();
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h; imgData = null;
    }
    if (!imgData) imgData = ctx.createImageData(w, h);
    imgData.data.set(new Uint8ClampedArray(M.HEAPU8.buffer, M._wasm_get_fb_rgba(), w * h * 4));
    ctx.putImageData(imgData, 0, 0);
    lastFbFrameCount = M._wasm_get_frame_count();
  };

  // Non-fastLoad (usesDh0) process-attach state: tryExec() arms an
  // AllocMem breakpoint once exec/graphics libraries are ready (execReady),
  // then getCurrentProcess() is checked on each hit until it identifies our
  // expectedProcessName CLI process (attached) — see rpc.ts. fastLoad
  // (usesDh0===false) has no separate attach step.
  let execReady = !usesDh0;
  let attached = !usesDh0;
  let allocMemAddr = 0;

  // Playback speed control (#speed dropdown, optional — debug.html omits it).
  // 1 = normal (100%) speed; values < 1 slow emulated time down relative to
  // wall-clock time, for slow-motion debugging.
  let speedFactor = 1;
  let emuClockMs = 0; // accumulated emulated time, scaled by speedFactor
  let lastTs: number | null = null;
  // Warp mode (#warp checkbox, optional): runs as many ticks as fit in
  // WARP_TICK_BUDGET_MS per tick-worker callback, ignoring speedFactor.
  // Mutually exclusive with the speed dropdown (disabled while warp is on).
  let warpMode = false;
  // Automatically forces warp mode for non-fastLoad (usesDh0) boots, for as long as
  // AmigaOS is still booting/running its startup-sequence (execReady/attached false) —
  // there's nothing meaningful to watch at normal speed until the program itself starts,
  // and DH0:-booting can otherwise take many real seconds. Tracked separately from the
  // user's own warpMode toggle (frame() ORs the two — see effectiveWarp) so the warp
  // button's own on/off state isn't clobbered by this automatic phase, and so it can
  // drive applyAudioMute() (which only re-runs on UI events, not every frame) exactly
  // when this phase starts/ends, not just when the user clicks the button.
  let bootWarpActive = false;
  // Tracks whether cycle-exact mode is currently disabled for warp, so frame()'s
  // effectiveWarp-transition block (below) only calls wasm_set_cycle_exact on an
  // actual change, not every frame. Cycle-exact bus/DMA-contention modeling is the
  // dominant per-instruction cost for compute-bound code (confirmed directly: a tight
  // register-bound loop profiled ~2x faster with it disabled) — disabling it while
  // warp is active (manual or bootWarpActive) is a big further speedup on top of
  // warp's own tick-budget-per-callback mechanism. Not preserved for accuracy-critical
  // work (profiling, DMA-precise debugging) — restored the instant warp ends.
  let cycleExactDisabledForWarp = false;

  // Audio can't play correctly at non-1x speed or in warp mode (pitch/rate
  // would need to change too), so mute it whenever either is active.
  function applyAudioMute(): void {
    if (gain) gain.gain.value = (audioMuted || warpMode || bootWarpActive || speedFactor !== 1) ? 0 : 0.5;
  }

  const speedSelect = document.getElementById("speed") as HTMLSelectElement | null;
  if (speedSelect) {
    speedFactor = parseFloat(speedSelect.value) || 1;
    speedSelect.addEventListener("change", () => {
      speedFactor = parseFloat(speedSelect.value) || 1;
      applyAudioMute();
    });
  }

  const warpButton = document.getElementById("warp");
  // Reflects effectiveWarp (warpMode || bootWarpActive), not just warpMode — so the
  // button visibly lights up during the automatic boot-warp phase too, not only when
  // the user has clicked it themselves. Called from both the click handler and
  // frame()'s bootWarpActive transition (see below) so the two stay consistent; the
  // speed dropdown is disabled under either source, since dueFrames-based pacing is
  // bypassed either way.
  function updateWarpButtonUI(): void {
    if (!warpButton) return;
    const active = warpMode || bootWarpActive;
    warpButton.classList.toggle("active", active);
    if (speedSelect) speedSelect.disabled = active;
  }
  if (warpButton) {
    warpButton.addEventListener("click", () => {
      warpMode = !warpMode;
      updateWarpButtonUI();
      applyAudioMute();
    });
  }

  const audioToggle = document.getElementById("audio-toggle");
  const audioToggleIcon = audioToggle?.querySelector(".codicon");
  function setAudioMuted(muted: boolean): void {
    audioMuted = muted;
    audioToggleIcon?.classList.toggle("codicon-mute", audioMuted);
    audioToggleIcon?.classList.toggle("codicon-unmute", !audioMuted);
    if (audioToggle) audioToggle.title = audioMuted ? "Unmute audio" : "Mute audio";
    if (!audioMuted) audioCtx?.resume(); // satisfies autoplay policy on first user gesture
    applyAudioMute();
  }
  if (audioToggle) {
    audioToggle.addEventListener("click", () => setAudioMuted(!audioMuted));
  }

  interface ToggleItem {
    key: number;
    text: string;
    title?: string;
    color?: string;
  }

  // Builds a labelled group of small numbered toggle squares (toolbar-style,
  // replacing the previous checkbox lists). `items` is [{ key, text, color? }];
  // onToggle(item, active) is called whenever a square is clicked.
  //
  // Groups with more than one item get an "ALL" toggle (mirroring the DMA overlay panel's
  // hand-rolled one below: state is derived, not stored — its `active` class is just "are all
  // items currently active", recomputed after every change, and clicking it drives every item
  // through the same per-item setter a normal click uses). Shift-clicking an item isolates it:
  // that item turns on and every other item in the group turns off.
  function makeToggleGroup(label: string, items: ToggleItem[], onToggle: (item: ToggleItem, active: boolean) => void): HTMLDivElement {
    const group = document.createElement("div");
    group.className = "chan-group";
    const lbl = document.createElement("span");
    lbl.className = "chan-group-label";
    lbl.textContent = label;
    group.appendChild(lbl);
    const grid = document.createElement("div");
    grid.className = "chan-grid";

    const btns: HTMLButtonElement[] = [];
    const setItem = (idx: number, active: boolean): void => {
      btns[idx].classList.toggle("active", active);
      onToggle(items[idx], active);
    };

    let allBtn: HTMLButtonElement | undefined;
    const syncAllBtn = (): void => {
      allBtn?.classList.toggle("active", btns.every(b => b.classList.contains("active")));
    };

    if (items.length > 1) {
      allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.className = "chan-btn all-btn active";
      allBtn.textContent = "ALL";
      allBtn.title = `Toggle all ${label.toLowerCase()}`;
      allBtn.addEventListener("click", () => {
        const turnOn = !btns.every(b => b.classList.contains("active"));
        items.forEach((_, idx) => setItem(idx, turnOn));
        syncAllBtn();
      });
      grid.appendChild(allBtn);
    }

    items.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chan-btn active";
      btn.textContent = item.text;
      btn.title = items.length > 1
        ? `${item.title || item.text} (Shift-click to isolate)`
        : item.title || item.text;
      if (item.color) btn.style.setProperty("--chan-color", item.color);
      btn.addEventListener("click", (e) => {
        if (e.shiftKey && items.length > 1) {
          items.forEach((_, i) => setItem(i, i === idx));
        } else {
          setItem(idx, !btn.classList.contains("active"));
        }
        syncAllBtn();
      });
      grid.appendChild(btn);
      btns.push(btn);
    });

    group.appendChild(grid);
    return group;
  }

  // DMA overlay panel (#dma-overlay, optional).
  // Controls: an "ALL" toggle, per-channel toggle squares, opacity slider.
  // There's no separate overlay-enable flag in the UI — the overlay is simply
  // enabled whenever at least one channel is active, and disabled when all
  // are off. All wired directly to the WASM overlay functions (no RPC
  // round-trip needed).
  //
  // No "Conflict" (DmaRecordType.CONFLICT) entry: verified unreachable in
  // practice — every known hardware DMA-priority quirk this emulator models
  // computes its merged result and logs it as an ordinary BITPLANE/REFRESH
  // record instead of ever triggering the generic conflict-detection path
  // (see dmaHover.ts's channelLabelFor comment). The toggle never
  // highlighted anything.
  const DMA_CHANNELS = [
    { type: DmaRecordType.REFRESH, label: "Refresh", abbr: "REF", color: "#444444" },
    { type: DmaRecordType.CPU, label: "CPU", abbr: "CPU", color: "#a25342" },
    { type: DmaRecordType.COPPER, label: "Copper", abbr: "COP", color: "#eeee00" },
    { type: DmaRecordType.AUDIO, label: "Audio", abbr: "AUD", color: "#ff0000" },
    { type: DmaRecordType.BLITTER, label: "Blitter", abbr: "BLT", color: "#008888" },
    { type: DmaRecordType.BITPLANE, label: "Bitplane", abbr: "BPL", color: "#0000ff" },
    { type: DmaRecordType.SPRITE, label: "Sprite", abbr: "SPR", color: "#ff00ff" },
    { type: DmaRecordType.DISK, label: "Disk", abbr: "DSK", color: "#ffffff" },
  ];

  // Whether any DMA overlay channel is on — gates the hover tooltip itself
  // (see installDmaHoverTooltip below): copper hovers additionally need
  // copperChannelActive, but other channels' (e.g. blitter) per-cycle info
  // only needs debug_dma, already on whenever any channel is enabled.
  let dmaOverlayActive = false;
  // DMARECORD_* types (DMA_CHANNELS' `type` values match these 1:1) whose
  // overlay toggle is currently on — the hover tooltip must only show info
  // for cells the overlay is actually drawing, not every DMA cycle that
  // happens to be recorded (debug_dma records every channel regardless of
  // which ones are toggled for the visual overlay).
  const enabledChannelTypes = new Set<number>();

  // Blit-region highlight. The actual pixel-accurate highlight is drawn C-side:
  // wasm_blit_vis_update() (called each frame below) stamps blitter-written
  // chip-RAM words; the emulator's render marks the on-screen pixels whose
  // source was recently blitted and blends a fading tint straight into the
  // framebuffer (see puae_debug.c / drawing.c / frontend_shim.c). JS only drives
  // the per-frame tag update and the enable toggle.
  let blitTrackingEnabled = false;

  const dmaOverlayPanel = document.getElementById("dma-overlay");
  if (dmaOverlayPanel) {
    const channelGroup = document.createElement("div");
    channelGroup.className = "chan-group";
    const channelLbl = document.createElement("span");
    channelLbl.className = "chan-group-label";
    channelLbl.textContent = "DMA";
    channelGroup.appendChild(channelLbl);

    const grid = document.createElement("div");
    grid.className = "chan-grid";

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "chan-btn all-btn";
    allBtn.textContent = "ALL";
    allBtn.title = "Toggle all DMA channels";
    grid.appendChild(allBtn);

    // wasm_dma_overlay_set_channel/enable/set_opacity only flip C-side
    // state — the actual RGBA recompositing normally only happens inside
    // shim_video_refresh, which needs a real wasm_tick() to run. While
    // paused, no ticks happen, so without this the overlay wouldn't visibly
    // update until the next step/resume. wasm_redraw_frame() re-applies the
    // current settings to the already-rendered frame and bumps the frame
    // counter, which frame()'s existing "redraw if framebuffer changed while
    // paused" path (below) then picks up on its next scheduled callback.
    function redrawOverlayIfPaused(): void {
      if (M._wasm_is_paused()) M._wasm_redraw_frame();
    }

    function setChannel(idx: number, active: boolean): void {
      const ch = DMA_CHANNELS[idx];
      channelBtns[idx].classList.toggle("active", active);
      M._wasm_dma_overlay_set_channel(ch.type, active ? 1 : 0);
      if (active) enabledChannelTypes.add(ch.type);
      else enabledChannelTypes.delete(ch.type);
      if (ch.type === DmaRecordType.COPPER) {
        M._wasm_copper_tracking_enable(active ? 1 : 0);
      }
      const anyActive = channelBtns.some(b => b.classList.contains("active"));
      dmaOverlayActive = anyActive;
      M._wasm_dma_overlay_enable(anyActive ? 1 : 0);
      dmaOverlayPanel!.classList.toggle("disabled", !anyActive);
      redrawOverlayIfPaused();
    }

    function syncAllBtn(): void {
      allBtn.classList.toggle("active", channelBtns.every(b => b.classList.contains("active")));
    }

    // Start with every channel off — the overlay is opt-in.
    const channelBtns = DMA_CHANNELS.map((ch, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chan-btn";
      btn.textContent = ch.abbr;
      btn.title = ch.label;
      btn.style.setProperty("--chan-color", ch.color);
      btn.addEventListener("click", () => {
        setChannel(idx, !btn.classList.contains("active"));
        syncAllBtn();
      });
      grid.appendChild(btn);
      return btn;
    });

    allBtn.addEventListener("click", () => {
      const turnOn = !channelBtns.every(b => b.classList.contains("active"));
      DMA_CHANNELS.forEach((_, idx) => setChannel(idx, turnOn));
      syncAllBtn();
    });

    channelGroup.appendChild(grid);
    dmaOverlayPanel.appendChild(channelGroup);
    dmaOverlayPanel.classList.add("disabled");

    // Opacity slider
    const opacityRow = document.createElement("div");
    opacityRow.className = "opacity-row";
    const opacityLbl = document.createElement("span");
    opacityLbl.className = "chan-group-label";
    opacityLbl.textContent = "Opacity";
    const opacitySlider = document.createElement("input");
    opacitySlider.type = "range";
    opacitySlider.min = "0";
    opacitySlider.max = "255";
    opacitySlider.value = "128";
    opacitySlider.addEventListener("input", () => {
      M._wasm_dma_overlay_set_opacity(parseInt(opacitySlider.value, 10));
      redrawOverlayIfPaused();
    });
    opacityRow.appendChild(opacityLbl);
    opacityRow.appendChild(opacitySlider);
    dmaOverlayPanel.appendChild(opacityRow);
  }

  // Browsers block audio autoplay until a user gesture; clicking the canvas
  // (like the explicit unmute button) satisfies that, so unmute automatically
  // rather than requiring a separate click on the toolbar button. Only
  // unmutes (never re-mutes) — a click elsewhere already muted stays muted.
  // Registered before installDmaHoverTooltip/installMouseCapture below so
  // their stopImmediatePropagation (DMA-hover's click-to-open-source path)
  // can't suppress this — it should fire on every canvas click regardless.
  canvas.addEventListener("click", () => {
    if (audioMuted) setAudioMuted(false);
  });

  // DMA overlay hover tooltip: shows brief info (disassembly for copper,
  // channel/data for blitter) under the cursor while any DMA channel is
  // active, restricted to cells whose channel is actually toggled on (see
  // enabledChannelTypes — debug_dma records every channel regardless of
  // which ones the overlay is drawing). Passing `vscode` (undefined outside
  // the real webview, e.g. debug.html) enables copper's and CPU instruction
  // fetches' source-location lookup and click-to-open.
  installDmaHoverTooltip(canvas, M, () => dmaOverlayActive, (type) => enabledChannelTypes.has(type), vscode);

  // Mouse capture (pointer lock) for the emulated Amiga mouse: left click
  // captures, middle click releases. Installed after the tooltip above so
  // its click listener runs second — the tooltip suppresses this one (via
  // stopImmediatePropagation) when a click instead opens a source file.
  installMouseCapture(canvas, M);

  // Keyboard capture for the emulated Amiga keyboard: click the canvas to
  // focus it, then keys are forwarded until focus moves elsewhere (e.g. to
  // one of this toolbar's own <select>/<input> controls).
  installKeyboardCapture(canvas, M);

  // Channel visibility panel (#channel-visibility, optional).
  // Numbered toggle squares to disable individual bitplanes, sprites, and
  // audio channels, plus a single toggle for the blitter (one channel, no
  // index — see wasm_set_blitter_enabled's comment for what "disable" means
  // for it specifically).
  const channelVisPanel = document.getElementById("channel-visibility");
  if (channelVisPanel) {
    function makeIndexedGroup(
      label: string,
      count: number,
      textFn: (i: number) => string,
      setter: (key: number, value: number) => void,
    ): HTMLDivElement {
      const items: ToggleItem[] = [];
      for (let i = 0; i < count; i++) items.push({ key: i, text: textFn(i) });
      return makeToggleGroup(label, items, (item, active) => setter(item.key, active ? 1 : 0));
    }

    channelVisPanel.appendChild(makeIndexedGroup(
      "Bitplanes", 8,
      i => String(i + 1),
      (i, v) => M._wasm_set_bitplane_enabled(i, v),
    ));
    channelVisPanel.appendChild(makeIndexedGroup(
      "Sprites", 8,
      i => String(i),
      (i, v) => M._wasm_set_sprite_enabled(i, v),
    ));
    channelVisPanel.appendChild(makeIndexedGroup(
      "Audio", 4,
      i => String(i),
      (i, v) => M._wasm_set_audio_channel_enabled(i, v),
    ));
    // Single channel, unlike the indexed groups above — one toggle square.
    channelVisPanel.appendChild(makeToggleGroup(
      "Blitter", [{ key: 0, text: "BLT" }],
      (_item, active) => M._wasm_set_blitter_enabled(active ? 1 : 0),
    ));
  }

  // Blit-region highlight toggle (#blit-vis, optional). The highlight itself is
  // rendered C-side (pixel-accurate tint blended into the framebuffer); here we
  // just flip tracking on/off. Force a redraw while paused so the change (in
  // particular clearing the tint on disable) shows immediately.
  const blitVisBtn = document.getElementById("blit-vis");
  const blitDecayRow = document.getElementById("blit-decay-row");
  const blitDecaySlider = document.getElementById("blit-decay") as HTMLInputElement | null;
  const blitDecayVal = document.getElementById("blit-decay-val");
  if (blitVisBtn) {
    blitVisBtn.addEventListener("click", () => {
      blitTrackingEnabled = !blitTrackingEnabled;
      blitVisBtn.classList.toggle("active", blitTrackingEnabled);
      blitDecayRow?.classList.toggle("disabled", !blitTrackingEnabled);
      M._wasm_blit_tracking_enable(blitTrackingEnabled ? 1 : 0);
      if (M._wasm_is_paused()) M._wasm_redraw_frame();
    });
  }
  // Decay slider: how many frames a blit stays highlighted (C-side fade).
  if (blitDecaySlider) {
    const applyDecay = (): void => {
      const frames = parseInt(blitDecaySlider.value, 10);
      M._wasm_blit_set_decay(frames);
      if (blitDecayVal) blitDecayVal.textContent = `${frames}f`;
      if (blitTrackingEnabled && M._wasm_is_paused()) M._wasm_redraw_frame();
    };
    blitDecaySlider.addEventListener("input", applyDecay);
    applyDecay(); // push the initial value to wasm
  }

  // Per-frame tag update: stamps the chip-RAM words the blitter wrote this frame
  // so the NEXT frame's render can highlight the pixels that read them. The
  // highlight is blended into the framebuffer C-side, so there is nothing to
  // draw here.
  function updateBlitVis(): void {
    M._wasm_blit_vis_update();
  }

  // Set up the audio graph now — this doesn't itself need a user gesture.
  // No "enable audio" button needed: the unlock listeners registered above
  // (via audioCtx.onstatechange) resume playback on the first click/keypress.
  startAudio().catch(e => console.error("[audio] init failed", e));

  function frame(ts: number): void {
    if (lastTs === null) { lastTs = ts; fpsTime = ts; }

    // Force warp mode while a non-fastLoad boot is still waiting for the program to
    // start (see bootWarpActive's declaration) — apply the mute/button-highlight side
    // effects only on the false->true/true->false transition, not every frame.
    const shouldBootWarp = usesDh0 && !attached;
    if (shouldBootWarp !== bootWarpActive) {
      bootWarpActive = shouldBootWarp;
      updateWarpButtonUI();
      applyAudioMute();
    }
    const effectiveWarp = warpMode || bootWarpActive;
    if (effectiveWarp !== cycleExactDisabledForWarp) {
      cycleExactDisabledForWarp = effectiveWarp;
      M._wasm_set_cycle_exact(effectiveWarp ? 0 : 1);
    }

    // Accumulate emulated time scaled by speedFactor, so changing speed
    // mid-session doesn't cause a discontinuous jump in dueFrames. Use the
    // AudioContext clock as the source while it's actually driving audio
    // (see lastAudioClockS above) so production can't drift from consumption;
    // otherwise fall back to the system clock.
    const useAudioClock = !!audioCtx && audioCtx.state === "running" && speedFactor === 1 && !effectiveWarp;
    if (useAudioClock) {
      const audioNowS = audioCtx!.currentTime;
      if (lastAudioClockS === null) lastAudioClockS = audioNowS; // avoid a jump when (re-)entering this mode
      emuClockMs += (audioNowS - lastAudioClockS) * 1000;
      lastAudioClockS = audioNowS;
    } else {
      emuClockMs += (ts - lastTs) * speedFactor;
      lastAudioClockS = null; // re-sync without a jump next time we enter audio-clock mode
    }
    lastTs = ts;

    // How many PAL frames should have elapsed (in emulated time) so far?
    let dueFrames = Math.floor(emuClockMs * PAL_FPS / 1000);
    // Drop backlog beyond MAX_CATCHUP_FRAMES instead of letting the catch-up loop below try to
    // replay it — see MAX_CATCHUP_FRAMES' comment. Pulls emuClockMs forward to match so this
    // dropped time doesn't resurface as backlog again on the next call.
    if (dueFrames - emuFrames > MAX_CATCHUP_FRAMES) {
      dueFrames = emuFrames + MAX_CATCHUP_FRAMES;
      emuClockMs = dueFrames * 1000 / PAL_FPS;
    }
    const wasPaused = M._wasm_is_paused();
    const fbFrameCount = M._wasm_get_frame_count();
    const fbDirty = fbFrameCount !== lastFbFrameCount;

    if (wasPaused) {
      // Don't try to "catch up" once resumed.
      emuFrames = dueFrames;
      // The framebuffer doesn't normally change while paused, so only draw
      // once — e.g. right after fastLoad injection pauses the CPU before
      // stopOnEntry, so the canvas isn't left blank for the whole time the
      // debugger is stopped. But if a reverse-stepping command (stepBack/
      // continueReverse/stepBackFrame) landed on a different point in time,
      // its replay re-renders the framebuffer (fbDirty) and we must redraw.
      if (imgData && !fbDirty) return;
    } else if (!effectiveWarp && dueFrames <= emuFrames) {
      return; // display is faster than 50 Hz — nothing to do yet
    }

    const tTickStart = performance.now();
    let hitBreakpoint = false;
    let ranCount = 0;
    if (wasPaused) {
      // no ticks to run
    } else if (effectiveWarp) {
      // Run flat-out for a time budget, ignoring speedFactor/dueFrames.
      while (performance.now() - tTickStart < WARP_TICK_BUDGET_MS) {
        M._wasm_tick();
        ranCount++;
        if (M._wasm_is_paused()) { hitBreakpoint = true; break; }
      }
    } else {
      // Run ticks until caught up to dueFrames, within a time budget. A flat
      // cap on ticks-per-callback (the previous approach) limits how fast a
      // frame debt incurred during a main-thread stall can be paid back —
      // any stall longer than the cap permanently shrinks the audio cushion
      // until the worklet's ring buffer underruns (the dominant cause of
      // jittery/crackly audio). Budgeting by time instead lets a single
      // callback fully repay an arbitrarily large debt, at the cost of an
      // occasional dropped video frame while catching up, which is
      // imperceptible.
      while (emuFrames + ranCount < dueFrames &&
             performance.now() - tTickStart < WARP_TICK_BUDGET_MS) {
        M._wasm_tick();
        ranCount++;
        if (M._wasm_is_paused()) { hitBreakpoint = true; break; }
      }
    }
    const tTickEnd = performance.now();
    emuFrames += ranCount;
    // Warp mode can run emuFrames ahead of the wall-clock schedule — pull
    // emuClockMs forward to match so playback doesn't "freeze" waiting for
    // real time to catch up once warp mode is turned off. Never moves
    // emuClockMs backward (normal-speed catch-up after falling behind still
    // works as before).
    emuClockMs = Math.max(emuClockMs, emuFrames * 1000 / PAL_FPS);

    // Periodic full-state checkpoint during a free-run, so stepBack/
    // continueReverse can rewind into the middle of a long `continue`, not
    // just back to its start (see rpc.ts's pushSnapshot). rpc is only
    // set inside the VS Code webview — debug.html has no RPC bridge.
    if (rpc && !wasPaused && ranCount > 0 && emuFrames - lastCheckpointFrame >= CHECKPOINT_INTERVAL_FRAMES) {
      lastCheckpointFrame = emuFrames;
      setTimeout(() => rpc!.pushSnapshot(), 0);
    }

    // [vscode-puae-debugger mem protect] Starts the AllocMem/FreeMem watch
    // as early as possible — well before tryExec's "user task started"
    // heuristic below, so Kickstart's own boot-time allocations (graphics.
    // library's default View/copper lists, etc.) get tracked too. The C side
    // validates execBase itself and no-ops until it's actually ready, so
    // it's safe to poll every frame; stop once it succeeds (calling it again
    // later would discard any AllocMem call currently in-flight).
    if (!memProtectTrackingStarted) {
      memProtectTrackingStarted = !!M._wasm_memprotect_start_tracking();
    }

    // Non-fastLoad (usesDh0) boot: poll for exec/graphics libraries being
    // ready, then arm the AllocMem breakpoint (tryExec) so the next hit can
    // be checked against getCurrentProcess() below.
    if (usesDh0 && !execReady) {
      const r = tryExec(M);
      if (r.ready) {
        execReady = true;
        allocMemAddr = r.allocMemAddr!;
        // [vscode-puae-debugger mem protect] GfxBase is confirmed set here
        // (tryExec/isExecReady checked it) — safe to walk the library list
        // now, unlike at the earlier raw-execBase tracking-start point above.
        M._wasm_memprotect_seed_libraries();
      }
    }

    if (hitBreakpoint) {
      if (usesDh0 && execReady && !attached) {
        // AllocMem breakpoint hit while waiting for our expectedProcessName CLI
        // process (s/startup-sequence) to start — check whether this is it yet.
        const proc = getCurrentProcess(M, expectedProcessName);
        if (proc) {
          M._wasm_remove_breakpoint(allocMemAddr);
          attached = true;
          log(`Attached to process "${proc.command}" (${proc.segments.length} segment(s))`);
          if (vscode) {
            vscode.postMessage({ type: "attached", segments: proc.segments });
          }
        } else {
          // Not our process yet (e.g. AmigaOS's own startup tasks) — keep
          // the breakpoint armed and resume.
          M._wasm_resume();
        }
      } else {
        log("BREAKPOINT HIT — emulator paused");
        if (onBreakpoint) onBreakpoint(M);

        // Tells the DAP adapter a breakpoint/watchpoint was hit during
        // continue, so it can send a StoppedEvent (handleStop,
        // debugAdapter.ts) — mirrors vAmiga_ui.js's handleStop.
        if (vscode) {
          vscode.postMessage({ type: "emulator-state", state: "stopped", message: getCurrentStopMessage(M) });
        }
      }
    }

    if (ranCount > 0) pushAccumToWorklet(); // push this tick's samples to the ring-buffer worklet

    const w = M._wasm_get_fb_width();
    const h = M._wasm_get_fb_height();
    if (!w || !h) return;

    // Resize canvas if the core reported a new geometry.
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      imgData = null; // invalidate cached ImageData on resize
    }

    // Chrome 117+ rejects new ImageData(wasmBackedView, w, h) with a TypeError,
    // so we own the ImageData's buffer and copy from wasm memory each frame.
    if (!imgData) imgData = ctx.createImageData(w, h);
    const ptr = M._wasm_get_fb_rgba();
    const tSetStart = performance.now();
    imgData.data.set(new Uint8ClampedArray(M.HEAPU8.buffer, ptr, w * h * 4));
    const tBlitStart = performance.now();
    ctx.putImageData(imgData, 0, 0);
    if (blitTrackingEnabled) updateBlitVis();
    const tBlitEnd = performance.now();
    // Re-read rather than reuse fbFrameCount (captured before this frame()
    // call's own tick loop, if any) so the comparison next time is accurate.
    lastFbFrameCount = M._wasm_get_frame_count();

    if (ranCount > 0) {
      fpsCnt += ranCount;
      if (ts - fpsTime >= 1000) {
        const fps = (fpsCnt * 1000 / (ts - fpsTime)).toFixed(1);
        const msWasm = ((tTickEnd - tTickStart) / ranCount).toFixed(1);
        const msSet = (tBlitStart - tSetStart).toFixed(1);
        const msBlit = (tBlitEnd - tBlitStart).toFixed(1);
        if (status) status.textContent = `${fps} fps | wasm=${msWasm}ms set=${msSet}ms blit=${msBlit}ms`;
        fpsCnt = 0;
        fpsTime = ts;
      }
    }
  }

  // Drive frame() from a Worker timer instead of requestAnimationFrame:
  // rAF is throttled to ~1Hz (or suspended entirely) when the webview tab
  // isn't visible, which would pause emulation whenever the user switches to
  // another VS Code panel. A dedicated Worker's setInterval keeps ticking at
  // a steady rate regardless of tab visibility (mirrors vAmiga_ui.js's
  // initEmulationWorker). frame()'s due-frames accounting already works off
  // wall-clock timestamps, so it doesn't care that ticks now come from a
  // timer instead of the display's refresh rate — tying the tick rate to
  // PAL_FPS just means one tick is due per call in the steady state.
  startTickWorker(frame, 1000 / PAL_FPS);
}
