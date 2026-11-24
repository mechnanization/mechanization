import type { ConfigService } from '@nestjs/config';
import { SmsProviderService } from './sms-provider.service';

/**
 * The development path, where no provider key is set and nothing is sent: its
 * log line is the only trace of the message, and the message is a sign-in code
 * (audit SEC-05, non-negotiable 7).
 */
function devSender(): { sender: SmsProviderService; lines: string[] } {
  const values: Record<string, string | undefined> = { NODE_ENV: 'development' };
  const sender = new SmsProviderService({ get: (key: string) => values[key] } as unknown as ConfigService);
  const lines: string[] = [];
  (sender as unknown as { logger: { debug: (line: string) => void } }).logger = {
    debug: (line) => lines.push(line),
  };
  return { sender, lines };
}

describe('SmsProviderService.send without a provider (development)', () => {
  it('logs the number masked and never the body', async () => {
    const { sender, lines } = devSender();

    await sender.send({ phone: '+96171234567', message: 'رمز الدخول: 482913', channel: 'PRIMARY' });

    expect(lines).toEqual(['[dev] SMS to +9617•••67 via PRIMARY (18 characters, not sent)']);
    expect(lines[0]).not.toContain('482913');
    expect(lines[0]).not.toContain('71234567');
  });
});
