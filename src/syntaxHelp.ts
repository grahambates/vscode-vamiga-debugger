type UsageDocs = Record<string, [string, string]>;

// ANSI color helper functions for maintainable colored text
const ansi = {
  reset: "\x1b[0m",
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,

  // Colors
  title: (text: string) => `\x1b[1;36m${text}\x1b[0m`, // Bold cyan
  section: (text: string) => `\x1b[1;33m${text}\x1b[0m`, // Bold yellow
  subsection: (text: string) => `\x1b[1;32m${text}\x1b[0m`, // Bold green
  func: (text: string) => `\x1b[96m${text}\x1b[0m`, // Bright cyan
  variable: (text: string) => `\x1b[95m${text}\x1b[0m`, // Magenta
  operator: (text: string) => `\x1b[93m${text}\x1b[0m`, // Yellow
  number: (text: string) => `\x1b[91m${text}\x1b[0m`, // Red
};

/**
 * Remove ANSI escape sequences from a string to get its visible length
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Pad a string to the specified length, ignoring ANSI escape codes
 */
function padEnd(str: string, targetLength: number, padString = " "): string {
  const visibleLength = stripAnsi(str).length;
  const paddingNeeded = targetLength - visibleLength;

  if (paddingNeeded <= 0) {
    return str;
  }

  return str + padString.repeat(paddingNeeded);
}

function funcDocs(docs: UsageDocs, indent = 4, pad = 24): string {
  let out = "";
  for (const doc of Object.values(docs)) {
    out += " ".repeat(indent) + padEnd(doc[0], pad) + " - " + doc[1] + "\n";
  }
  return out;
}

export const memoryAccessFunctions: UsageDocs = {
  peekU32: [
    `${ansi.func("peekU32")}(${ansi.variable("addr")})`,
    "Read 32-bit unsigned value from memory",
  ],
  peekU16: [
    `${ansi.func("peekU16")}(${ansi.variable("addr")})`,
    "Read 16-bit unsigned value from memory",
  ],
  peekU8: [
    `${ansi.func("peekU8")}(${ansi.variable("addr")})`,
    "Read 8-bit unsigned value from memory",
  ],
  peekI32: [
    `${ansi.func("peekI32")}(${ansi.variable("addr")})`,
    "Read 32-bit signed value from memory",
  ],
  peekI16: [
    `${ansi.func("peekI16")}(${ansi.variable("addr")})`,
    "Read 16-bit signed value from memory",
  ],
  peekI8: [
    `${ansi.func("peekI8")}(${ansi.variable("addr")})`,
    "Read 8-bit signed value from memory",
  ],
  poke32: [
    `${ansi.func("poke32")}(${ansi.variable("addr")}, ${ansi.variable("val")})`,
    "Write 32-bit value to memory",
  ],
  poke16: [
    `${ansi.func("poke16")}(${ansi.variable("addr")}, ${ansi.variable("val")})`,
    "Write 16-bit value to memory",
  ],
  poke8: [
    `${ansi.func("poke8")}(${ansi.variable("addr")}, ${ansi.variable("val")})`,
    "Write 8-bit value to memory",
  ],
};

export const typeFunctions: UsageDocs = {
  u32: [
    `${ansi.func("u32")}(${ansi.variable("val")})`,
    "Convert to 32-bit unsigned",
  ],
  u16: [
    `${ansi.func("u16")}(${ansi.variable("val")})`,
    "Convert to 16-bit unsigned",
  ],
  u8: [
    `${ansi.func("u8")}(${ansi.variable("val")})`,
    "Convert to 8-bit unsigned",
  ],
  i32: [
    `${ansi.func("i32")}(${ansi.variable("val")})`,
    "Convert to 32-bit signed",
  ],
  i16: [
    `${ansi.func("i16")}(${ansi.variable("val")})`,
    "Convert to 16-bit signed",
  ],
  i8: [
    `${ansi.func("i8")}(${ansi.variable("val")})`,
    "Convert to 8-bit signed",
  ],
};

export const parserBuiltInFunctions: UsageDocs = {
  // Unary
  abs: [
    `${ansi.func("abs")}(${ansi.variable("x")})`,
    "Absolute value (magnitude) of x",
  ],
  acos: [
    `${ansi.func("acos")}(${ansi.variable("x")})`,
    "Arc cosine of x (in radians)",
  ],
  acosh: [
    `${ansi.func("acosh")}(${ansi.variable("x")})`,
    "Hyperbolic arc cosine of x (in radians)",
  ],
  asin: [
    `${ansi.func("asin")}(${ansi.variable("x")})`,
    "Arc sine of x (in radians)",
  ],
  asinh: [
    `${ansi.func("asinh")}(${ansi.variable("x")})`,
    "Hyperbolic arc sine of x (in radians)",
  ],
  atan: [
    `${ansi.func("atan")}(${ansi.variable("x")})`,
    "Arc tangent of x (in radians)",
  ],
  atanh: [
    `${ansi.func("atanh")}(${ansi.variable("x")})`,
    "Hyperbolic arc tangent of x (in radians)",
  ],
  cbrt: [`${ansi.func("cbrt")}(${ansi.variable("x")})`, "Cube root of x"],
  ceil: [
    `${ansi.func("ceil")}(${ansi.variable("x")})`,
    "Ceiling of x — the smallest integer that’s >= x",
  ],
  cos: [
    `${ansi.func("cos")}(${ansi.variable("x")})`,
    "Cosine of x (x is in radians)",
  ],
  cosh: [
    `${ansi.func("cosh")}(${ansi.variable("x")})`,
    "Hyperbolic cosine of x (x is in radians)",
  ],
  exp: [
    `${ansi.func("exp")}(${ansi.variable("x")})`,
    "e^x (exponential/antilogarithm function with base e)",
  ],
  expm1: [`${ansi.func("expm1")}(${ansi.variable("x")})`, "e^x - 1"],
  floor: [
    `${ansi.func("floor")}(${ansi.variable("x")})`,
    "Floor of x — the largest integer that’s <= x",
  ],
  length: [
    `${ansi.func("length")}(${ansi.variable("x")})`,
    "String or array length of x",
  ],
  ln: [`${ansi.func("ln")}(${ansi.variable("x")})`, "Natural logarithm of x"],
  log: [
    `${ansi.func("log")}(${ansi.variable("x")})`,
    "Natural logarithm of x (synonym for ln, not base-10)",
  ],
  log10: [
    `${ansi.func("log10")}(${ansi.variable("x")})`,
    "Base-10 logarithm of x",
  ],
  log2: [
    `${ansi.func("log2")}(${ansi.variable("x")})`,
    "Base-2 logarithm of x",
  ],
  log1p: [
    `${ansi.func("log1p")}(${ansi.variable("x")})`,
    "Natural logarithm of (1 + x)",
  ],
  not: [`${ansi.func("not")}(${ansi.variable("x")})`, "Logical NOT operator"],
  round: [
    `${ansi.func("round")}(${ansi.variable("x")})`,
    'X, rounded to the nearest integer, using "grade-school rounding"',
  ],
  sign: [
    `${ansi.func("sign")}(${ansi.variable("x")})`,
    "Sign of x (-1, 0, or 1 for negative, zero, or positive respectively)",
  ],
  sin: [
    `${ansi.func("sin")}(${ansi.variable("x")})`,
    "Sine of x (x is in radians)",
  ],
  sinh: [
    `${ansi.func("sinh")}(${ansi.variable("x")})`,
    "Hyperbolic sine of x (x is in radians)",
  ],
  sqrt: [
    `${ansi.func("sqrt")}(${ansi.variable("x")})`,
    "Square root of x. Result is NaN (Not a Number) if x is negative.",
  ],
  tan: [
    `${ansi.func("tan")}(${ansi.variable("x")})`,
    "Tangent of x (x is in radians)",
  ],
  tanh: [
    `${ansi.func("tanh")}(${ansi.variable("x")})`,
    "Hyperbolic tangent of x (x is in radians)",
  ],
  trunc: [
    `${ansi.func("trunc")}(${ansi.variable("x")})`,
    "Integral part of a X, looks like floor(x) unless for negative numb",
  ],
  // Others:
  random: [
    `${ansi.func("random")}(${ansi.variable("n")})`,
    `Get a random number in the range [0, n). If n is zero, or not provided, it defaults to 1.`,
  ],
  fac: [
    `${ansi.func("fac")}(${ansi.variable("n")})`,
    `n! (factorial of n: "n * (n-1) * (n-2) * … * 2 * 1") Deprecated. Use the ! operator instead.`,
  ],
  min: [
    `${ansi.func("min")}(${ansi.variable("a")},${ansi.variable("b")},…)`,
    `Get the smallest (minimum) number in the list.`,
  ],
  max: [
    `${ansi.func("max")}(${ansi.variable("a")},${ansi.variable("b")},…)`,
    `Get the largest (maximum) number in the list.`,
  ],
  hypot: [
    `${ansi.func("hypot")}(${ansi.variable("a")}, ${ansi.variable("b")})`,
    `Hypotenuse, i.e. the square root of the sum of squares of its arguments.`,
  ],
  pyt: [
    `${ansi.func("pyt")}(${ansi.variable("a")}, ${ansi.variable("b")})`,
    `Alias for hypot.`,
  ],
  pow: [
    `${ansi.func("pow")}(${ansi.variable("x")}, ${ansi.variable("y")})`,
    `Equivalent to x^y. For consistency with JavaScript's Math object.`,
  ],
  atan2: [
    `${ansi.func("atan2")}(${ansi.variable("y")}, ${ansi.variable("x")})`,
    `Arc tangent of x/y. i.e. the angle between (0, 0) and (x, y) in radians.`,
  ],
  roundTo: [
    `${ansi.func("roundTo")}(${ansi.variable("x")}, ${ansi.variable("n")})`,
    `Rounds x to n places after the decimal point.`,
  ],
  map: [
    `${ansi.func("map")}(${ansi.variable("f")}, ${ansi.variable("a")})`,
    `Array map: Pass each element of a the function f, and return an array of the results.`,
  ],
  fold: [
    `${ansi.func("fold")}(${ansi.variable("f")}, ${ansi.variable("y")}, ${ansi.variable("a")})`,
    `Array fold: Fold/reduce array a into a single value, y by setting y = f(y, x, index) for each element x of the array.`,
  ],
  filter: [
    `${ansi.func("filter")}(${ansi.variable("f")}, ${ansi.variable("a")})`,
    `Array filter: Return an array containing only the values from a where f(x, index) is true.`,
  ],
  indexOf: [
    `${ansi.func("indexOf")}(${ansi.variable("x")}, ${ansi.variable("a")})`,
    `Return the first index of string or array a matching the value x, or -1 if not found.`,
  ],
  join: [
    `${ansi.func("join")}(${ansi.variable("sep")}, ${ansi.variable("a")})`,
    `Concatenate the elements of a, separated by sep.`,
  ],
  if: [
    `${ansi.func("if")}(${ansi.variable("c")}, ${ansi.variable("a")}, ${ansi.variable("b")})`,
    `Function form of c ? a : b. Note: This always evaluates both a and b, regardless of whether c is true or not. Use c ? a : b instead if there are side effects, or if evaluating the branches could be expensive.`,
  ],
};

export const consoleCommands: UsageDocs = {
  help: [`${ansi.func("help")} [syntax|functions]`, "Show REPL usage guide, or further documentation for category"],
};

export const allFunctions: UsageDocs = {
  ...memoryAccessFunctions,
  ...typeFunctions,
  ...parserBuiltInFunctions,
};

export const helpText = `${ansi.title("REPL Help - vAmiga Debugger Expression Evaluator")}

Uses JavaScript-like syntax for expressions. Type '${ansi.func("help syntax")}' for details.
All CPU registers, custom chip registers, and symbol names are available as variables.

${ansi.section("Available Functions:")}
  ${ansi.subsection("Memory Access:")}
${funcDocs(memoryAccessFunctions)}

  ${ansi.subsection("Type Conversion:")}
${funcDocs(typeFunctions)}

  ${ansi.subsection("Misc:")}
    Most math related functions are available with standard names e.g.  ${ansi.func("round")}, ${ansi.func("floor")}, ${ansi.func("min")}, ${ansi.func("max")}
    Type '${ansi.func("help functions")}' for full list.

${ansi.section("Available Variables:")}
  ${ansi.subsection("CPU Registers:")} ${ansi.variable("d0-d7")}, ${ansi.variable("a0-a7")}, ${ansi.variable("pc")}, ${ansi.variable("sr")} etc.
  ${ansi.subsection("Custom Chip Registers:")} ${ansi.variable("DMACONR")}, ${ansi.variable("INTENAR")}, ${ansi.variable("INTREQR")}, ${ansi.variable("ADKCONR")}, etc.
  ${ansi.subsection("Symbol Names:")} All symbols (i.e. labels) from your debug program

${ansi.section("Examples:")}
  ${ansi.func("i16")}(${ansi.variable("d0")})            - Get signed word value of register d0
  ${ansi.func("peekU32")}(${ansi.variable("a0")})        - Read long from address in a0
  ${ansi.func("poke16")}(${ansi.variable("Speed")}, ${ansi.number("100")}) - Write word to address of 'Speed' symbol
  ${ansi.variable("main")} + ${ansi.number("0x10")}        - Symbol address + offset
`;

export const initOutput = `${ansi.title("VSCode vAmiga Debugger by Graham Bates (gigabates/DESiRE)")}
vAmigaWeb (c) mithrendal https://vamigaweb.github.io/doc/
vAmiga (c) Dirk W. Hoffmann https://dirkwhoffmann.github.io/vAmiga/

type 'help' for REPL usage guide
`;

export const functionsText = `${ansi.section("Available Functions:")}
  ${ansi.subsection("Memory Access:")}
${funcDocs(memoryAccessFunctions)}

  ${ansi.subsection("Type Conversion:")}
${funcDocs(typeFunctions)}
  ${ansi.subsection("Misc:")}
${funcDocs(parserBuiltInFunctions)}`

const col1W = 28;
const col2W = 16;

export const syntaxText = `${ansi.section("Syntax:")}
Syntax provided by ${ansi.bold("expr-eval")} https://github.com/silentmatt/expr-eval
The parser accepts a pretty basic grammar. It's similar to normal JavaScript expressions, but is more math-oriented. For example, the ^ operator is exponentiation, not xor.

${padEnd(ansi.subsection("Operator"), col1W)} ${padEnd(ansi.subsection("Associativity"), col2W)} ${ansi.subsection("Description")}
${padEnd(`${ansi.operator("(...)")}`, col1W)} ${padEnd("None", col2W)} Grouping
${padEnd(`${ansi.operator("f()")}, ${ansi.operator("x.y")}, ${ansi.operator("a[i]")}`, col1W)} ${padEnd("Left", col2W)} Function call, property access, array indexing
${padEnd(`${ansi.operator("!")}`, col1W)} ${padEnd("Left", col2W)} Factorial
${padEnd(`${ansi.operator("^")}`, col1W)} ${padEnd("Right", col2W)} Exponentiation
${padEnd(`${ansi.operator("+")}, ${ansi.operator("-")}, ${ansi.func("not")}, ${ansi.func("sqrt")}, etc.`, col1W)} ${padEnd("Right", col2W)} Unary prefix operators
${padEnd(`${ansi.operator("*")}, ${ansi.operator("/")}, ${ansi.operator("%")}`, col1W)} ${padEnd("Left", col2W)} Multiplication, division, remainder
${padEnd(`${ansi.operator("+")}, ${ansi.operator("-")}, ${ansi.operator("||")}`, col1W)} ${padEnd("Left", col2W)} Addition, subtraction, array concatenation
${padEnd(`${ansi.operator("==")}, ${ansi.operator("!=")}, ${ansi.operator(">=")}, ${ansi.operator("<=")}, ${ansi.operator(">")}, ${ansi.operator("<")}, ${ansi.operator("in")}`, col1W)} ${padEnd("Left", col2W)} Comparison operators
${padEnd(`${ansi.operator("and")}`, col1W)} ${padEnd("Left", col2W)} Logical AND
${padEnd(`${ansi.operator("or")}`, col1W)} ${padEnd("Left", col2W)} Logical OR
${padEnd(`${ansi.operator("x ? y : z")}`, col1W)} ${padEnd("Right", col2W)} Ternary conditional (if x then y else z)
${padEnd(`${ansi.operator("=")}`, col1W)} ${padEnd("Right", col2W)} Variable assignment
${padEnd(`${ansi.operator(";")}`, col1W)} ${padEnd("Left", col2W)} Expression separator
`