import { describe, expect, it } from 'vitest';
import { pino } from 'pino';

/**
 * A Matter node taken out of the home stays commissioned if the controller
 * never got to it — and a node left commissioned is attached and announced
 * again at the next start, as a new device. So `forget` says it could not,
 * and the registry keeps the device waiting for a start that can
 * (`DeviceRegistry.removeDevice`).
 */
describe('forgetting a Matter node', () => {
  it('refuses, rather than pretending, while the controller is not running', async () => {
    const { MatterAdapter } = await import('../src/adapters/matter/adapter.js');
    const adapter = new MatterAdapter({ dataDir: '/nonexistent/gethome-test', log: pino({ level: 'silent' }) });
    await expect(adapter.forget('4')).rejects.toThrow('not running');
  });
});
