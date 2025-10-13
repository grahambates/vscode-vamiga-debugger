/**
 * Shared types for the Amiga State Viewer webview
 */

/**
 * RGB color value from Amiga's 4-bit RGB format
 */
export interface AmigaColor {
  /** 4-bit red value (0-15) */
  r: number;
  /** 4-bit green value (0-15) */
  g: number;
  /** 4-bit blue value (0-15) */
  b: number;
  /** Register number (0-31) */
  register: number;
}

/**
 * Display configuration and state information
 */
export interface DisplayState {
  /** Color palette (32 colors from COLOR00-COLOR31 registers) */
  palette: AmigaColor[];
  /** Number of active bitplanes (0-6) */
  bitplanes?: number;
  /** Is interlaced mode enabled */
  interlaced?: boolean;
  /** Is high-res mode enabled */
  hires?: boolean;
  /** Is HAM (Hold-And-Modify) mode enabled */
  ham?: boolean;
  /** Is DPF (Dual Playfield) mode enabled */
  dpf?: boolean;
  /** Is ECS mode enabled (from BPLCON0) */
  ecsEna?: boolean;
  /** Playfield 2 horizontal position (from BPLCON1) */
  pf2h?: number;
  /** Playfield 1 horizontal position (from BPLCON1) */
  pf1h?: number;
  /** Playfield 2 priority over pf1 (from BPLCON2) */
  pf2Pri: boolean;
  /** Playfield 2 priority with respect to sprites (from BPLCON2) */
  pf2p: number;
  /** Playfield 1 priority with respect to sprites (from BPLCON2) */
  pf1p: number;
  /** Are border sprites enabled (from BPLCON3) */
  borderSprites?: boolean;
  /** Is border transparent (from BPLCON3) */
  borderTransparent?: boolean;
  /** Is border blanked (from BPLCON3) */
  borderBlank?: boolean;
  /** Display window start register value */
  diwstrt: string;
  /** Display window stop register value */
  diwstop: string;
  /** Display data fetch start register value */
  ddfstrt: string;
  /** Display data fetch stop register value */
  ddfstop: string;
}

/**
 * Messages from extension to webview
 */
export interface UpdateDisplayStateMessage {
  command: "updateDisplayState";
  displayState: DisplayState;
}

/**
 * Messages from webview to extension
 */
export interface ReadyMessage {
  command: "ready";
}

export interface RefreshMessage {
  command: "refresh";
}

export type StateViewerMessage = ReadyMessage | RefreshMessage;
