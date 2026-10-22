/* com.apple.syslog_relay sends log lines terminated by "\n\0", split arbitrarily across reads. */

const LEVEL_COLORS: Record<string, string> = { Fault: '\x1b[31;1m', Error: '\x1b[31m', Warning: '\x1b[33m', Info: '\x1b[2m', Debug: '\x1b[2m' };

/** Splits buffered text into complete lines; the unfinished tail is returned as `pending`. */
export function splitSyslog(pending: string, text: string): { lines: string[]; pending: string } {
  const parts = (pending + text).split('\n\0');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter(Boolean), pending: rest };
}

/** Colors a syslog line by its <Level>, as Console.app does. */
export function formatSyslogLine(line: string): string {
  const level = /<(Fault|Error|Warning|Notice|Info|Debug)>:/.exec(line)?.[1];
  const color = level ? LEVEL_COLORS[level] : undefined;
  return color ? `${color}${line}\x1b[0m` : line;
}
