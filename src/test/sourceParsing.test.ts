import { parseLine } from "../sourceParsing";
describe("parse", () => {
  describe("#parseLine()", () => {
    it("parses a complete instruction line", () => {
      const line = parseLine(
        "label:    move.w     #1,10(a0,d1,w)    ; comment here",
      );
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
        mnemonic: { start: 10, end: 14, value: "move" },
        size: { start: 15, end: 16, value: "w" },
        operands: [
          { start: 21, end: 23, value: "#1" },
          { start: 24, end: 35, value: "10(a0,d1,w)" },
        ],
        comment: { start: 39, end: 53, value: "; comment here" },
      });
    });

    it("parses an instruction line with no size", () => {
      const line = parseLine("label: move #1,10(a0,d1,w) ; comment here");
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
        mnemonic: { start: 7, end: 11, value: "move" },
        operands: [
          { start: 12, end: 14, value: "#1" },
          { start: 15, end: 26, value: "10(a0,d1,w)" },
        ],
        comment: { start: 27, end: 41, value: "; comment here" },
      });
    });

    it("parses a line with only a label", () => {
      const line = parseLine("label:");
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
      });
    });

    it("parses a label with no colon", () => {
      const line = parseLine("label");
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
      });
    });

    it("parses a label with double colon", () => {
      const line = parseLine("label::");
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
      });
    });

    it("parses a local label", () => {
      const line = parseLine(".label:");
      expect(line).toEqual({
        label: { start: 0, end: 6, value: ".label" },
      });
    });

    it("parses a local label with alternate syntax", () => {
      const line = parseLine("label$:");
      expect(line).toEqual({
        label: { start: 0, end: 6, value: "label$" },
      });
    });

    it("parses a label with leading whitespace", () => {
      const line = parseLine("   label:");
      expect(line).toEqual({
        label: { start: 3, end: 8, value: "label" },
      });
    });

    it("parses a label and mnemonic with no whitespace", () => {
      const line = parseLine("label:rts");
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
        mnemonic: { start: 6, end: 9, value: "rts" },
      });
    });

    it("parses an instruction line with no label", () => {
      const line = parseLine("     move.w #1,10(a0,d1,w) ; comment here");
      expect(line).toEqual({
        mnemonic: { start: 5, end: 9, value: "move" },
        size: { start: 10, end: 11, value: "w" },
        operands: [
          { start: 12, end: 14, value: "#1" },
          { start: 15, end: 26, value: "10(a0,d1,w)" },
        ],
        comment: { start: 27, end: 41, value: "; comment here" },
      });
    });

    it("parses an instruction line with no operands", () => {
      const line = parseLine("     bra.s ; comment here");
      expect(line).toEqual({
        mnemonic: { start: 5, end: 8, value: "bra" },
        size: { start: 9, end: 10, value: "s" },
        comment: { start: 11, end: 25, value: "; comment here" },
      });
    });

    it("parses a comment by position", () => {
      const line = parseLine("label: move #1,10(a0,d1.w) comment here");
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
        mnemonic: { start: 7, end: 11, value: "move" },
        operands: [
          { start: 12, end: 14, value: "#1" },
          { start: 15, end: 26, value: "10(a0,d1.w)" },
        ],
        comment: { start: 27, end: 39, value: "comment here" },
      });
    });

    it("parses a comment by position for instructions with no operands", () => {
      const line = parseLine(" rts comment here");
      expect(line).toEqual({
        mnemonic: { start: 1, end: 4, value: "rts" },
        comment: { start: 5, end: 17, value: "comment here" },
      });
    });

    it("parses a comment by separator for macros with no operands", () => {
      const line = parseLine(" mcr ; comment here");
      expect(line).toEqual({
        mnemonic: { start: 1, end: 4, value: "mcr" },
        comment: { start: 5, end: 19, value: "; comment here" },
      });
    });

    it("parses operands with space after comma", () => {
      const line = parseLine(
        "label:    move.w     #1, 10(a0,d1,w)    ; comment here",
      );
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
        mnemonic: { start: 10, end: 14, value: "move" },
        size: { start: 15, end: 16, value: "w" },
        operands: [
          { start: 21, end: 23, value: "#1" },
          { start: 25, end: 36, value: "10(a0,d1,w)" },
        ],
        comment: { start: 40, end: 54, value: "; comment here" },
      });
    });

    it("parses an empty line", () => {
      const line = parseLine("");
      expect(line).toEqual({});
    });

    it("parses a line with only whitespace", () => {
      const line = parseLine("  ");
      expect(line).toEqual({});
    });

    it("parses '=' as a mnemonic", () => {
      const line = parseLine("label = value");
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
        mnemonic: { start: 6, end: 7, value: "=" },
        operands: [{ start: 8, end: 13, value: "value" }],
      });
    });

    it("parses '=' as a mnemonic with no whitespace", () => {
      const line = parseLine("label=value");
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
        mnemonic: { start: 5, end: 6, value: "=" },
        operands: [{ start: 6, end: 11, value: "value" }],
      });
    });

    it("parses an incomplete size", () => {
      const line = parseLine("label:    move.");
      expect(line).toEqual({
        label: { start: 0, end: 5, value: "label" },
        mnemonic: { start: 10, end: 14, value: "move" },
        size: { start: 15, end: 15, value: "" },
      });
    });

    it("parses an incomplete operand list", () => {
      const line = parseLine(" move d0,");
      expect(line).toEqual({
        mnemonic: { start: 1, end: 5, value: "move" },
        operands: [
          { start: 6, end: 8, value: "d0" },
          { start: 9, end: 9, value: "" },
        ],
      });
    });

    it("parses an operand containing spaces in double quotes", () => {
      const line = parseLine(' dc.b "foo bar baz" ; comment');
      expect(line).toEqual({
        mnemonic: { start: 1, end: 3, value: "dc" },
        size: { start: 4, end: 5, value: "b" },
        operands: [{ start: 6, end: 19, value: '"foo bar baz"' }],
        comment: {
          end: 29,
          start: 20,
          value: "; comment",
        },
      });
    });

    it("parses an operand containing spaces with in single quotes", () => {
      const line = parseLine(" dc.b 'foo bar baz' ; comment");
      expect(line).toEqual({
        mnemonic: { start: 1, end: 3, value: "dc" },
        size: { start: 4, end: 5, value: "b" },
        operands: [{ start: 6, end: 19, value: "'foo bar baz'" }],
        comment: {
          end: 29,
          start: 20,
          value: "; comment",
        },
      });
    });

    it("parses an operand containing spaces with unbalanced quotes", () => {
      const line = parseLine(" dc.b 'foo bar baz");
      expect(line).toEqual({
        mnemonic: { start: 1, end: 3, value: "dc" },
        size: { start: 4, end: 5, value: "b" },
        operands: [{ start: 6, end: 18, value: "'foo bar baz" }],
      });
    });

    it("parses a label containing a numeric macro parameter", () => {
      const line = parseLine("foo\\1bar: rts");
      expect(line).toEqual({
        label: { start: 0, end: 8, value: "foo\\1bar" },
        mnemonic: { start: 10, end: 13, value: "rts" },
      });
    });

    it("parses a label containing a special char macro parameter", () => {
      const line = parseLine("foo\\@bar: rts");
      expect(line).toEqual({
        label: { start: 0, end: 8, value: "foo\\@bar" },
        mnemonic: { start: 10, end: 13, value: "rts" },
      });
    });

    it("parses a label containing a quoted macro parameter", () => {
      const line = parseLine("foo\\<reptn>bar: rts");
      expect(line).toEqual({
        label: { start: 0, end: 14, value: "foo\\<reptn>bar" },
        mnemonic: { start: 16, end: 19, value: "rts" },
      });
    });

    it("parses a mnemonic containing a macro parameter", () => {
      const line = parseLine(" b\\1 d0,d1");
      expect(line).toEqual({
        mnemonic: { start: 1, end: 4, value: "b\\1" },
        operands: [
          { start: 5, end: 7, value: "d0" },
          { start: 8, end: 10, value: "d1" },
        ],
      });
    });

    it("parses a size containing a macro parameter", () => {
      const line = parseLine(" move.\\1 d0,d1");
      expect(line).toEqual({
        mnemonic: { start: 1, end: 5, value: "move" },
        size: { start: 6, end: 8, value: "\\1" },
        operands: [
          { start: 9, end: 11, value: "d0" },
          { start: 12, end: 14, value: "d1" },
        ],
      });
    });

    it("parses an operand containing a macro parameter", () => {
      const line = parseLine(" move \\1,d0");
      expect(line).toEqual({
        mnemonic: { start: 1, end: 5, value: "move" },
        operands: [
          { start: 6, end: 8, value: "\\1" },
          { start: 9, end: 11, value: "d0" },
        ],
      });
    });

    it("parses a quoted macro arguments", () => {
      const line = parseLine('    FOO     <1,"foo">,d2');
      expect(line).toEqual({
        mnemonic: { start: 4, end: 7, value: "FOO" },
        operands: [
          { start: 12, end: 21, value: '<1,"foo">' },
          { start: 22, end: 24, value: "d2" },
        ],
      });
    });

    it("parses a complex statement with parens", () => {
      const line = parseLine(
        " dc.w	ddfstop,(DIW_XSTRT-17+(DIW_W>>4-1)<<4)>>1&$fc-SCROLL*8",
      );
      expect(line).toEqual({
        mnemonic: {
          end: 3,
          start: 1,
          value: "dc",
        },
        operands: [
          {
            end: 13,
            start: 6,
            value: "ddfstop",
          },
          {
            start: 14,
            end: 60,
            value: "(DIW_XSTRT-17+(DIW_W>>4-1)<<4)>>1&$fc-SCROLL*8",
          },
        ],
        size: {
          end: 5,
          start: 4,
          value: "w",
        },
      });
    });
  });
});
