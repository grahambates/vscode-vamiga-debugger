export type Size = "s" | "b" | "w" | "l";

export interface ParsedLine {
  label?: Component;
  mnemonic?: Component;
  size?: Component;
  operands?: Component[];
  comment?: Component;
}

export interface Component {
  start: number;
  end: number;
  value: string;
}

export enum ComponentType {
  Label,
  Mnemonic,
  Size,
  Operand,
  Comment,
}

export interface ComponentInfo {
  type: ComponentType;
  component: Component;
  index?: number;
}

// Regex to match line components:
// ^
// (?<label>                           Label:
//   ([^:\s;*=]+:?:?)                  - anything at start of line - optional colon
//   |                                   or...
//   (\s+[^:\s;*=]+::?)                - can have leading whitespace with colon present
// )?
// (\s*                                Instruction or directive:
//   (
//                                     Need seprate case for instructions/directives without operands
//                                     in order for position based comments to work
//                                     i.e. any text following one of these mnemonics should be treated
//                                     as a comment:
//
//     (                                 No-operand mnemonics:
//       (?<mnemonic1>\.?(nop|reset|rte|rtr|rts|trapv|illegal|clrfo|clrso|comment|einline|even|inline|list|mexit|nolist|nopage|odd|page|popsection|pushsection|rsreset|endif|endc|else|elseif|endm|endr|erem))
//       (?<size1>\.[a-z0-9_.]*)?          - Size qualifier
//     )
//     |
//     (                                 Any other mnemonic:
//       (?<mnemonic>([^\s.,;*=]+|=))               - Mnemonic
//       (?<size>\.[^\s.,;*]*)?                     - Size qualifier
//       (\s*(?<operands>                           - Operand list:
//         (?<op1>                     First operand
//          "([^"]*)"?|                 - double quoted
//          '([^']*)'?|                 - singled quoted
//          <([^>]*)>?|                 - chevron quoted
//          [^\s;,]+                    - anything else
//         )
//         (?<op2>,\s*(                Additional comma separated operands
//          "([^"]*)"?|
//          '([^']*)'?|
//          <([^>]*)>?|
//          [^\s;,]*)
//         )*))?
//     )
//   )
// )?
// (\s*(?<comment>.+))?                Comment (any trailing text)
// $
const pattern =
  /^(?<label>([^:\s;*=]+:?:?)|(\s+[^:\s;*=]+::?))?(\s*(((?<mnemonic1>\.?(nop|reset|rte|rtr|rts|trapv|illegal|clrfo|clrso|comment|einline|even|inline|list|mexit|nolist|nopage|odd|page|popsection|pushsection|rsreset|endif|endc|else|elseif|endm|endr|erem))(?<size1>\.[a-z0-9_.]*)?)|((?<mnemonic>([^\s.,;*=]+|=))(?<size>\.[^\s.,;*]*)?(\s*(?<operands>(?<op1>"([^"]*)"?|'([^']*)'?|<([^>]*)>?|[^\s;,]+)(?<op2>,\s*("([^"]*)"?|'([^']*)'?|<([^>]*)>?|[^\s;,]*))*))?)))?(\s*(?<comment>.+))?$/i;

/**
 * Parse a single line of source code into positional components
 *
 * This is much simpler than the syntax tree returned by Tree Sitter but is
 * also less strict and useful for parsing incomplete lines as you type.
 */
export function parseLine(text: string): ParsedLine {
  const line: ParsedLine = {};
  const groups = pattern.exec(text)?.groups;
  if (groups) {
    let end = 0;

    if (groups.label) {
      let value = groups.label.trim();
      while (value.endsWith(":")) {
        value = value.substring(0, value.length - 1);
      }
      const start = text.indexOf(value);
      end = start + value.length;
      line.label = { start, end, value };
    }

    if (groups.mnemonic || groups.mnemonic1) {
      const value = groups.mnemonic || groups.mnemonic1;
      const start = end + text.substring(end).indexOf(value);
      end = start + value.length;
      line.mnemonic = { start, end, value };
    }

    if (groups.size || groups.size1) {
      let value = groups.size || groups.size1;
      const start = end + text.substring(end).indexOf(value) + 1;
      value = value.substring(1);
      end = start + value.length;
      line.size = { start, end, value };
    }

    if (groups.operands) {
      // Split on comma, unless in parens
      const values = groups.operands.split(/,\s*(?![^()<>]*[)>])/);

      const operands: Component[] = [];
      for (const value of values) {
        const start = value
          ? end + text.substring(end).indexOf(value)
          : end + 1;
        end = start + value.length;
        operands.push({ start, end, value });
      }

      line.operands = operands;
    }

    if (groups.comment && groups.comment.trim()) {
      const value = groups.comment;
      const start = end + text.substring(end).indexOf(value);
      end = start + value.length;
      line.comment = { start, end, value };
    }
  }

  return line;
}

const longDefault = ["moveq", "exg", "lea", "pea"];
const byteDefault = [
  "nbcd",
  "abcd",
  "sbcd",
  "tas",
  "scc",
  "scs",
  "seq",
  "sge",
  "sgt",
  "shi",
  "sle",
  "slt",
  "smi",
  "sne",
  "spl",
  "svc",
  "svs",
  "st",
  "sf",
  "sls",
];
const bitOps = ["bchg", "bset", "bclr", "btst"];

export function instructionAttrs(line: string): {
  byteLength: number;
  signed: boolean;
} {
  let byteLength = 2;
  let signed = false;
  const parsed = parseLine(line);
  const size = parsed.size?.value;
  const mnemonic = parsed.mnemonic?.value.toLowerCase();
  // TODO: edge case where op doesn't match instruction size: divu/divs dest, any others?
  if (size) {
    // Map size to byte length:
    const sizeMap: Record<Size, number> = {
      s: 1,
      b: 1,
      w: 2,
      l: 4,
    };
    byteLength = sizeMap[size as Size];
  } else {
    // default to word
    byteLength = 2;

    // Instruction specific defaults:
    if (mnemonic) {
      if (longDefault.includes(mnemonic)) {
        byteLength = 4;
      } else if (byteDefault.includes(mnemonic)) {
        byteLength = 1;
      } else if (bitOps.includes(mnemonic)) {
        // depends on dest type
        byteLength = parsed.operands?.[1].value.match(/^d[0-7]$/i) ? 4 : 1;
      }
    }
  }
  // Check for signed instructions
  if (mnemonic) {
    signed = ["muls", "divs", "asr", "asl"].includes(mnemonic);
  }

  return { byteLength, signed };
}
