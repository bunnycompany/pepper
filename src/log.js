const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  magenta: wrap('35'),
  white: wrap('97'),
  bgRed: wrap('41;97;1'),
};

const ts = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (...a) => console.log(c.dim(ts()), ...a),
  warn: (...a) => console.warn(c.dim(ts()), c.yellow('!'), ...a),
  err: (...a) => console.error(c.dim(ts()), c.red('✗'), ...a),
};
