import { MemoryCheckpointStore } from './checkpoint.js';
import { SseRelayClient, type RelayContext, type RelayOptions } from './client.js';
import type { RelayEvent } from './protocol.js';

/** Bounded starting points. Choose deliberately; neither profile promises durable delivery. */
export const RelayProfiles = Object.freeze({
  NOTIFICATIONS: Object.freeze({
    retry: Object.freeze({ maxAttempts: 8, minDelayMs: 250, maxDelayMs: 10000, jitter: 0.2 }),
    connectTimeoutMs: 10000, idleTimeoutMs: 45000,
    limits: Object.freeze({ maxFrameBytes: 65536, maxQueuedEvents: 128, maxQueuedBytes: 1048576, dedupEntries: 1024 }),
  }),
  LIVE_FEED: Object.freeze({
    retry: Object.freeze({ maxAttempts: 8, minDelayMs: 250, maxDelayMs: 5000, jitter: 0.2 }),
    connectTimeoutMs: 10000, idleTimeoutMs: 30000,
    limits: Object.freeze({ maxFrameBytes: 65536, maxQueuedEvents: 256, maxQueuedBytes: 2097152, dedupEntries: 2048 }),
  }),
});
export interface JsonEventHandlerOptions<T> {
  /** Validate the business payload; throw to leave the event uncommitted. */
  decode(value: unknown): T;
  onData(value: T, context: RelayContext, event: RelayEvent): void | Promise<void>;
}
/** JSON parsing and business decoding remain inside the awaited processing/checkpoint boundary. */
export function jsonEventHandler<T>({ decode, onData }: JsonEventHandlerOptions<T>): RelayOptions['onEvent'] {
  return (event, context) => onData(decode(JSON.parse(event.data) as unknown), context, event);
}
export type JsonRelayOptions<T> = Omit<RelayOptions, 'onEvent'> & JsonEventHandlerOptions<T>;
/** A typed JSON stream with a memory checkpoint by default; ownership and start/stop remain explicit. */
export function createJsonRelay<T>({ decode, onData, ...options }: JsonRelayOptions<T>): SseRelayClient {
  return new SseRelayClient({ ...RelayProfiles.NOTIFICATIONS, checkpoint: new MemoryCheckpointStore(), ...options,
    onEvent: jsonEventHandler({ decode, onData }) });
}
