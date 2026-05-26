import type { TelemetryClient, TelemetryEvent } from './client.js';
import { withTelemetry } from './interceptor.js';

class RecordingClient implements TelemetryClient {
  events: TelemetryEvent[] = [];
  track(event: TelemetryEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
}

describe('withTelemetry', () => {
  it('emits integration.mcp.invoked with success=true on normal return', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    await wrapped({});

    expect(client.events).toHaveLength(1);
    expect(client.events[0].event).toBe('integration.mcp.invoked');
    expect(client.events[0].properties?.tool).toBe('list_templates');
    expect(client.events[0].properties?.success).toBe(true);
    expect(client.events[0].properties?.errorClass).toBeUndefined();
    expect(typeof client.events[0].properties?.durationMs).toBe('number');
  });

  it('emits success=false + errorClass when result.isError is true', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'generate_pdf_sync', async () => ({
      isError: true as const,
      content: [{ type: 'text' as const, text: 'boom' }],
    }));

    await wrapped({});

    expect(client.events[0].properties?.success).toBe(false);
    expect(client.events[0].properties?.errorClass).toBe('ToolError');
  });

  it('emits success=false + Error class name on thrown errors and rethrows', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'authenticate', async () => {
      throw new TypeError('nope');
    });

    await expect(wrapped({})).rejects.toThrow('nope');
    expect(client.events[0].properties?.success).toBe(false);
    expect(client.events[0].properties?.errorClass).toBe('TypeError');
  });

  it('captures workspaceId from input when present', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', async () => ({
      content: [{ type: 'text' as const, text: '' }],
    }));

    await wrapped({ workspaceId: '0eLHZZ8PxpU4Z5r7' });

    expect(client.events[0].workspaceId).toBe('0eLHZZ8PxpU4Z5r7');
  });

  it('omits workspaceId when not present in input', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', async () => ({
      content: [{ type: 'text' as const, text: '' }],
    }));

    await wrapped({});

    expect(client.events[0].workspaceId).toBeUndefined();
  });
});
