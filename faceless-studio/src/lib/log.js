const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m",
};

let indent = 0;
const pad = () => "  ".repeat(indent);

export const log = {
  step(msg) { console.log(`${pad()}${C.cyan}${C.bold}>${C.reset} ${msg}`); },
  info(msg) { console.log(`${pad()}  ${msg}`); },
  dim(msg) { console.log(`${pad()}  ${C.dim}${msg}${C.reset}`); },
  ok(msg) { console.log(`${pad()}  ${C.green}OK${C.reset} ${msg}`); },
  warn(msg) { console.warn(`${pad()}  ${C.yellow}!${C.reset}  ${msg}`); },
  err(msg) { console.error(`${pad()}  ${C.red}x${C.reset}  ${msg}`); },
  title(msg) { console.log(`\n${C.bold}${msg}${C.reset}`); },
  group(msg) { this.step(msg); indent++; },
  end() { indent = Math.max(0, indent - 1); },
};

export function fail(msg) {
  log.err(msg);
  process.exit(1);
}
