import { check, RuntimeError } from './errors.mjs';

/** User-run terminal entry only. No echo, environment, history or credential file. */
export function readMaskedSecret({ input = process.stdin, output = process.stderr } = {}) {
  check(input.isTTY && output.isTTY && typeof input.setRawMode === 'function',
    'TTY_REQUIRED', 'Use a private interactive terminal; piped key entry is disabled');
  return new Promise((resolve, reject) => {
    let value = ''; const wasRaw = Boolean(input.isRaw); const wasPaused = input.isPaused();
    const finish = (error, secret) => {
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
      input.setRawMode(wasRaw); if (wasPaused) input.pause();
      value = ''; output.write('\n'); error ? reject(error) : resolve(secret);
    };
    const onEnd = () => finish(new RuntimeError('CANCELLED', 'Key entry closed'));
    const onError = () => finish(new RuntimeError('CREDENTIAL_REQUIRED', 'Key entry failed'));
    const onData = data => {
      for (const character of data.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004') { finish(new RuntimeError('CANCELLED', 'Key entry cancelled')); return; }
        if (character === '\r' || character === '\n') {
          if (value.length < 16) { finish(new RuntimeError('CREDENTIAL_REQUIRED', 'Key value was too short')); return; }
          finish(null, value); return;
        }
        if (character === '\u007f' || character === '\b') { value = value.slice(0, -1); continue; }
        if (!/[!-~]/.test(character) || value.length >= 512) { finish(new RuntimeError('CREDENTIAL_REQUIRED', 'Key value was rejected')); return; }
        value += character;
      }
    };
    output.write('DeepSeek API key (hidden; kept in this process only): ');
    input.setRawMode(true); input.on('data', onData); input.once('end', onEnd); input.once('error', onError); input.resume();
  });
}
