import { DebugProtocol } from "@vscode/debugprotocol";

// RESET             = 1,    // CPU reset exception
// BUS_ERROR         = 2,    // Bus error
// ADDRESS_ERROR     = 3,    // Address error
// ILLEGAL           = 4,    // Illegal instruction
// DIVIDE_BY_ZERO    = 5,    // Division by zero
// CHK               = 6,    // CHK instruction exception
// TRAPV             = 7,    // TRAPV instruction exception
// PRIVILEGE         = 8,    // Privilege violation
// TRACE             = 9,    // Trace exception
// LINEA             = 10,   // Line A emulator trap
// LINEF             = 11,   // Line F emulator trap
// FORMAT_ERROR      = 14,   // Stack frame format error
// IRQ_UNINITIALIZED = 15,   // Uninitialized interrupt request
// IRQ_SPURIOUS      = 24,   // Spurious interrupt
// TRAP              = 32,   // TRAP instruction exception

export const exceptionBreakpointFilters: DebugProtocol.ExceptionBreakpointsFilter[] =
  [
    // { filter: "1", label: "CPU reset", default: false },
    { filter: "2", label: "Bus error", default: true },
    { filter: "3", label: "Address error", default: true },
    { filter: "4", label: "Illegal instruction", default: true },
    { filter: "5", label: "Zero divide", default: true },
    // { filter: '6', label: 'CHK instruction', default: false },
    // { filter: '7', label: 'TRAPV instruction', default: false },
    { filter: "8", label: "Privilege violation", default: false },
  ];

// What's your vector Victor?
export const vectors = [
  "RESET_SSP",
  "RESET_PC",
  "BUS_ERROR",
  "ADR_ERROR",
  "ILLEG_OPC",
  "DIV_BY_0",
  "CHK",
  "TRAPV",
  "PRIVIL_VIO",
  "TRACE",
  "LINEA_EMU",
  "LINEF_EMU",
  null,
  null,
  null,
  "INT_UNINIT",
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  "INT_UNJUST",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "NMI",
  "TRAP_00",
  "TRAP_01",
  "TRAP_02",
  "TRAP_03",
  "TRAP_04",
  "TRAP_05",
  "TRAP_06",
  "TRAP_07",
  "TRAP_08",
  "TRAP_09",
  "TRAP_10",
  "TRAP_11",
  "TRAP_12",
  "TRAP_13",
  "TRAP_14",
  "TRAP_15",
];

export interface CustomAddress {
  address: number;
  long: boolean;
}

/**
 * Address and length for custom register writes
 */
export const customAddresses: Record<string, CustomAddress> = {
  BLTDDAT: { address: 0xdff000, long: false }, // Blitter dest. early read (dummy address)
  // DMACONR: { address: 0xdff002, long: false }, // Dma control (and blitter status) read
  JOY0DAT: { address: 0xdff00a, long: false }, // Joystick-mouse 0 data (vert, horiz)
  JOY1DAT: { address: 0xdff00c, long: false }, // Joystick-mouse 1 data (vert, horiz)
  CLXDAT: { address: 0xdff00e, long: false }, // Collision data reg. (read and clear)
  // ADKCONR: { address: 0xdff010, long: false }, // Audio,disk control register read
  POT0DAT: { address: 0xdff012, long: false }, // Pot counter data left pair (vert, horiz)
  POT1DAT: { address: 0xdff014, long: false }, // Pot counter data right pair (vert, horiz)
  POTINP: { address: 0xdff016, long: false }, // Pot pin data read
  SERDATR: { address: 0xdff018, long: false }, // Serial port data and status read
  DSKBYTR: { address: 0xdff01a, long: false }, // Disk data byte and status read
  // INTENAR: { address: 0xdff01c, long: false }, // Interrupt enable bits read
  // INTREQR: { address: 0xdff01e, long: false }, // Interrupt request bits read
  DSKPT: { address: 0xdff020, long: true }, // Disk pointer
  DSKLEN: { address: 0xdff024, long: false }, // Disk length
  DSKDAT: { address: 0xdff026, long: false }, // Disk DMA data write
  REFPTR: { address: 0xdff028, long: true }, // Refresh pointer
  VPOS: { address: 0xdff02a, long: false }, // Write vert most sig. bits (and frame flop)
  VHPOS: { address: 0xdff02c, long: false }, // Write vert and horiz pos of beam
  COPCON: { address: 0xdff02e, long: false }, // Coprocessor control
  SERDAT: { address: 0xdff030, long: false }, // Serial port data and stop bits write
  SERPER: { address: 0xdff032, long: false }, // Serial port period and control
  POTGO: { address: 0xdff034, long: false }, // Pot count start,pot pin drive enable data
  JOYTEST: { address: 0xdff036, long: false }, // Write to all 4 joystick-mouse counters at once
  STREQU: { address: 0xdff038, long: false }, // Strobe for horiz sync with VB and EQU
  STRVBL: { address: 0xdff03a, long: false }, // Strobe for horiz sync with VB (vert blank)
  STRHOR: { address: 0xdff03c, long: false }, // Strobe for horiz sync
  STRLONG: { address: 0xdff03e, long: false }, // Strobe for identification of long horiz line
  BLTCON0: { address: 0xdff040, long: false }, // Blitter control register 0
  BLTCON1: { address: 0xdff042, long: false }, // Blitter control register 1
  BLTAFWM: { address: 0xdff044, long: false }, // Blitter first word mask for source A
  BLTALWM: { address: 0xdff046, long: false }, // Blitter last word mask for source A
  BLTCPT: { address: 0xdff048, long: true }, // Blitter pointer to source C
  BLTBPT: { address: 0xdff04c, long: true }, // Blitter pointer to source B
  BLTAPT: { address: 0xdff050, long: true }, // Blitter pointer to source A
  BLTDPT: { address: 0xdff054, long: true }, // Blitter pointer to dest D
  BLTSIZE: { address: 0xdff058, long: false }, // Blitter start and size (win/width,height)
  BLTCON0L: { address: 0xdff05a, long: false }, // control 0, lower 8 bits (minterms)
  BLTSIZV: { address: 0xdff05c, long: false }, // V size (for 15 bit vertical size)
  BLTSIZH: { address: 0xdff05e, long: false }, // H size and start (for 11 bit H size)
  BLTCMOD: { address: 0xdff060, long: false }, // Blitter modulo for source C
  BLTBMOD: { address: 0xdff062, long: false }, // Blitter modulo for source B
  BLTAMOD: { address: 0xdff064, long: false }, // Blitter modulo for source A
  BLTDMOD: { address: 0xdff066, long: false }, // Blitter modulo for dest D
  BLTCDAT: { address: 0xdff070, long: false }, // Blitter source C data register
  BLTBDAT: { address: 0xdff072, long: false }, // Blitter source B data register
  BLTADAT: { address: 0xdff074, long: false }, // Blitter source A data register
  SPRHDAT: { address: 0xdff078, long: true }, // . logic UHRES sprite pointer and data identifier
  BPLHDAT: { address: 0xdff07a, long: false }, // . logic UHRES bit plane identifier
  DENISEID: { address: 0xdff07c, long: false }, // revision level for Denise/Lisa (video out chip)
  DSKSYNC: { address: 0xdff07e, long: false }, // Disk sync pattern reg for disk read
  COP1LC: { address: 0xdff080, long: true }, // Coprocessor 1st location
  COP2LC: { address: 0xdff084, long: true }, // Coprocessor 2nd locatio
  COPJMP1: { address: 0xdff088, long: false }, // Coprocessor restart at 1st location
  COPJMP2: { address: 0xdff08a, long: false }, // Coprocessor restart at 2nd location
  COPINS: { address: 0xdff08c, long: false }, // Coprocessor inst fetch identify
  DIWSTRT: { address: 0xdff08e, long: false }, // Display window start (upper left vert,horiz pos)
  DIWSTOP: { address: 0xdff090, long: false }, // Display window stop (lower right vert,horiz pos)
  DDFSTRT: { address: 0xdff092, long: false }, // Display bit plane data fetch start,horiz pos
  DDFSTOP: { address: 0xdff094, long: false }, // Display bit plane data fetch stop,horiz pos
  DMACON: { address: 0xdff096, long: false }, // DMA control write (clear or set)
  CLXCON: { address: 0xdff098, long: false }, // Collision control
  INTENA: { address: 0xdff09a, long: false }, // Interrupt enable bits (clear or set bits)
  INTREQ: { address: 0xdff09c, long: false }, // Interrupt request bits (clear or set bits)
  ADKCON: { address: 0xdff09e, long: false }, // Audio,disk,UART control
  AUD0LC: { address: 0xdff0a0, long: true }, // Audio channel 0 location
  AUD0LCH: { address: 0xdff0a0, long: false }, // Audio channel 0 location (high 5 bits was 3 bits)
  AUD0LCL: { address: 0xdff0a2, long: false }, // Audio channel 0 location (low 15 bits)
  AUD0LEN: { address: 0xdff0a4, long: false }, // Audio channel 0 length
  AUD0PER: { address: 0xdff0a6, long: false }, // Audio channel 0 period
  AUD0VOL: { address: 0xdff0a8, long: false }, // Audio channel 0 volume
  AUD0DAT: { address: 0xdff0aa, long: false }, // Audio channel 0 data
  AUD1LC: { address: 0xdff0b0, long: true }, // Audio channel 1 location
  AUD1LEN: { address: 0xdff0b4, long: false }, // Audio channel 1 length
  AUD1PER: { address: 0xdff0b6, long: false }, // Audio channel 1 period
  AUD1VOL: { address: 0xdff0b8, long: false }, // Audio channel 1 volume
  AUD1DAT: { address: 0xdff0ba, long: false }, // Audio channel 1 data
  AUD2LC: { address: 0xdff0c0, long: true }, // Audio channel 2 location
  AUD2LEN: { address: 0xdff0c4, long: false }, // Audio channel 2 length
  AUD2PER: { address: 0xdff0c6, long: false }, // Audio channel 2 period
  AUD2VOL: { address: 0xdff0c8, long: false }, // Audio channel 2 volume
  AUD2DAT: { address: 0xdff0ca, long: false }, // Audio channel 2 data
  AUD3LC: { address: 0xdff0d0, long: true }, // Audio channel 3 location
  AUD3LCH: { address: 0xdff0d0, long: false }, // Audio channel 3 location (high 5 bits was 3 bits)
  AUD3LCL: { address: 0xdff0d2, long: false }, // Audio channel 3 location (low 15 bits)
  AUD3LEN: { address: 0xdff0d4, long: false }, // Audio channel 3 length
  AUD3PER: { address: 0xdff0d6, long: false }, // Audio channel 3 period
  AUD3VOL: { address: 0xdff0d8, long: false }, // Audio channel 3 volume
  AUD3DAT: { address: 0xdff0da, long: false }, // Audio channel 3 data
  BPL1PT: { address: 0xdff0e0, long: true }, // Bitplane pointer 1
  BPL2PT: { address: 0xdff0e4, long: true }, // Bitplane pointer 2
  BPL3PT: { address: 0xdff0e8, long: true }, // Bitplane pointer 3
  BPL4PT: { address: 0xdff0ec, long: true }, // Bitplane pointer 4
  BPL5PT: { address: 0xdff0f0, long: true }, // Bitplane pointer 5
  BPL6PT: { address: 0xdff0f4, long: true }, // Bitplane pointer 6
  BPL7PT: { address: 0xdff0f8, long: true }, // 7
  BPL8PT: { address: 0xdff0fc, long: true }, // 8
  BPLCON0: { address: 0xdff100, long: false }, // Bitplane control (miscellaneous control bits)
  BPLCON1: { address: 0xdff102, long: false }, // Bitplane control (scroll value)
  BPLCON2: { address: 0xdff104, long: false }, // Bitplane control (video priority control)
  BPLCON3: { address: 0xdff106, long: false }, // Bitplane control (enhanced features)
  BPL1MOD: { address: 0xdff108, long: false }, // Bitplane modulo (odd planes)
  BPL2MOD: { address: 0xdff10a, long: false }, // Bitplane modulo (even planes)
  BPLCON4: { address: 0xdff10c, long: false }, // (bitplane and sprite-masks)
  CLXCON2: { address: 0xdff10e, long: false }, // control
  BPL1DAT: { address: 0xdff110, long: false }, // Bitplane 1 data (parallel to serial convert)
  BPL2DAT: { address: 0xdff112, long: false }, // Bitplane 2 data (parallel to serial convert)
  BPL3DAT: { address: 0xdff114, long: false }, // Bitplane 3 data (parallel to serial convert)
  BPL4DAT: { address: 0xdff116, long: false }, // Bitplane 4 data (parallel to serial convert)
  BPL5DAT: { address: 0xdff118, long: false }, // Bitplane 5 data (parallel to serial convert)
  BPL6DAT: { address: 0xdff11a, long: false }, // Bitplane 6 data (parallel to serial convert)
  BPL7DAT: { address: 0xdff11c, long: false }, // data (parallel to serial convert)
  BPL8DAT: { address: 0xdff11e, long: false }, // data (parallel to serial convert)
  SPR0PT: { address: 0xdff120, long: true }, // Sprite 0 pointer
  SPR1PT: { address: 0xdff124, long: true }, // Sprite 1 pointer
  SPR2PT: { address: 0xdff128, long: true }, // Sprite 2 pointer
  SPR3PT: { address: 0xdff12c, long: true }, // Sprite 3 pointer
  SPR4PT: { address: 0xdff130, long: true }, // Sprite 4 pointer
  SPR5PT: { address: 0xdff134, long: true }, // Sprite 5 pointer
  SPR6PT: { address: 0xdff138, long: true }, // Sprite 6 pointer
  SPR7PT: { address: 0xdff13c, long: true }, // Sprite 7 pointer
  SPR0POS: { address: 0xdff140, long: false }, // Sprite 0 vert,horiz start pos data
  SPR0CTL: { address: 0xdff142, long: false }, // Sprite 0 position and control data
  SPR0DATA: { address: 0xdff144, long: false }, // Sprite 0 image data register A
  SPR0DATB: { address: 0xdff146, long: false }, // Sprite 0 image data register B
  SPR1POS: { address: 0xdff148, long: false }, // Sprite 1 vert,horiz start pos data
  SPR1CTL: { address: 0xdff14a, long: false }, // Sprite 1 position and control data
  SPR1DATA: { address: 0xdff14c, long: false }, // Sprite 1 image data register A
  SPR1DATB: { address: 0xdff14e, long: false }, // Sprite 1 image data register B
  SPR2POS: { address: 0xdff150, long: false }, // Sprite 2 vert,horiz start pos data
  SPR2CTL: { address: 0xdff152, long: false }, // Sprite 2 position and control data
  SPR2DATA: { address: 0xdff154, long: false }, // Sprite 2 image data register A
  SPR2DATB: { address: 0xdff156, long: false }, // Sprite 2 image data register B
  SPR3POS: { address: 0xdff158, long: false }, // Sprite 3 vert,horiz start pos data
  SPR3CTL: { address: 0xdff15a, long: false }, // Sprite 3 position and control data
  SPR3DATA: { address: 0xdff15c, long: false }, // Sprite 3 image data register A
  SPR3DATB: { address: 0xdff15e, long: false }, // Sprite 3 image data register B
  SPR4POS: { address: 0xdff160, long: false }, // Sprite 4 vert,horiz start pos data
  SPR4CTL: { address: 0xdff162, long: false }, // Sprite 4 position and control data
  SPR4DATA: { address: 0xdff164, long: false }, // Sprite 4 image data register A
  SPR4DATB: { address: 0xdff166, long: false }, // Sprite 4 image data register B
  SPR5POS: { address: 0xdff168, long: false }, // Sprite 5 vert,horiz start pos data
  SPR5CTL: { address: 0xdff16a, long: false }, // Sprite 5 position and control data
  SPR5DATA: { address: 0xdff16c, long: false }, // Sprite 5 image data register A
  SPR5DATB: { address: 0xdff16e, long: false }, // Sprite 5 image data register B
  SPR6POS: { address: 0xdff170, long: false }, // Sprite 6 vert,horiz start pos data
  SPR6CTL: { address: 0xdff172, long: false }, // Sprite 6 position and control data
  SPR6DATA: { address: 0xdff174, long: false }, // Sprite 6 image data register A
  SPR6DATB: { address: 0xdff176, long: false }, // Sprite 6 image data register B
  SPR7POS: { address: 0xdff178, long: false }, // Sprite 7 vert,horiz start pos data
  SPR7CTL: { address: 0xdff17a, long: false }, // Sprite 7 position and control data
  SPR7DATA: { address: 0xdff17c, long: false }, // Sprite 7 image data register A
  SPR7DATB: { address: 0xdff17e, long: false }, // Sprite 7 image data register B
  COLOR00: { address: 0xdff180, long: false }, // Color table 0
  COLOR01: { address: 0xdff182, long: false }, // Color table 1
  COLOR02: { address: 0xdff184, long: false }, // Color table 2
  COLOR03: { address: 0xdff186, long: false }, // Color table 3
  COLOR04: { address: 0xdff188, long: false }, // Color table 4
  COLOR05: { address: 0xdff18a, long: false }, // Color table 5
  COLOR06: { address: 0xdff18c, long: false }, // Color table 6
  COLOR07: { address: 0xdff18e, long: false }, // Color table 7
  COLOR08: { address: 0xdff190, long: false }, // Color table 8
  COLOR09: { address: 0xdff192, long: false }, // Color table 9
  COLOR10: { address: 0xdff194, long: false }, // Color table 10
  COLOR11: { address: 0xdff196, long: false }, // Color table 11
  COLOR12: { address: 0xdff198, long: false }, // Color table 12
  COLOR13: { address: 0xdff19a, long: false }, // Color table 13
  COLOR14: { address: 0xdff19c, long: false }, // Color table 14
  COLOR15: { address: 0xdff19e, long: false }, // Color table 15
  COLOR16: { address: 0xdff1a0, long: false }, // Color table 16
  COLOR17: { address: 0xdff1a2, long: false }, // Color table 17
  COLOR18: { address: 0xdff1a4, long: false }, // Color table 18
  COLOR19: { address: 0xdff1a6, long: false }, // Color table 19
  COLOR20: { address: 0xdff1a8, long: false }, // Color table 20
  COLOR21: { address: 0xdff1aa, long: false }, // Color table 21
  COLOR22: { address: 0xdff1ac, long: false }, // Color table 22
  COLOR23: { address: 0xdff1ae, long: false }, // Color table 23
  COLOR24: { address: 0xdff1b0, long: false }, // Color table 24
  COLOR25: { address: 0xdff1b2, long: false }, // Color table 25
  COLOR26: { address: 0xdff1b4, long: false }, // Color table 26
  COLOR27: { address: 0xdff1b6, long: false }, // Color table 27
  COLOR28: { address: 0xdff1b8, long: false }, // Color table 28
  COLOR29: { address: 0xdff1ba, long: false }, // Color table 29
  COLOR30: { address: 0xdff1bc, long: false }, // Color table 30
  COLOR31: { address: 0xdff1be, long: false }, // Color table 31
  HTOTAL: { address: 0xdff1c0, long: false }, // number count, horiz line (VARBEAMEN=1)
  HSSTOP: { address: 0xdff1c2, long: false }, // line position for HSYNC stop
  HBSTRT: { address: 0xdff1c4, long: false }, // line position for HBLANK start
  HBSTOP: { address: 0xdff1c6, long: false }, // line position for HBLANK stop
  VTOTAL: { address: 0xdff1c8, long: false }, // numbered vertical line (VARBEAMEN=1)
  VSSTOP: { address: 0xdff1ca, long: false }, // line position for VSYNC stop
  VBSTRT: { address: 0xdff1cc, long: false }, // line for VBLANK start
  VBSTOP: { address: 0xdff1ce, long: false }, // line for VBLANK stop
  SPRHSTRT: { address: 0xdff1d0, long: false }, // sprite vertical start
  SPRHSTOP: { address: 0xdff1d2, long: false }, // sprite vertical stop
  BPLHSTRT: { address: 0xdff1d4, long: false }, // bit plane vertical start
  BPLHSTOP: { address: 0xdff1d6, long: false }, // bit plane vertical stop
  HHPOSW: { address: 0xdff1d8, long: false }, // mode hires H beam counter write
  HHPOSR: { address: 0xdff1da, long: false }, // mode hires H beam counter read
  BEAMCON0: { address: 0xdff1dc, long: false }, // Beam counter control register (SHRES,UHRES,PAL)
  HSSTRT: { address: 0xdff1de, long: false }, // sync start (VARHSY)
  VSSTRT: { address: 0xdff1e0, long: false }, // sync start (VARVSY)
  HCENTER: { address: 0xdff1e2, long: false }, // position for Vsync on interlace
  DIWHIGH: { address: 0xdff1e4, long: false }, // window - upper bits for start/stop
  BPLHMOD: { address: 0xdff1e6, long: false }, // bit plane modulo
  SPRHPT: { address: 0xdff1e8, long: true }, // sprite pointer
  BPLHPT: { address: 0xdff1ec, long: true }, //
  FMODE: { address: 0xdff1fc, long: false }, // register
};
