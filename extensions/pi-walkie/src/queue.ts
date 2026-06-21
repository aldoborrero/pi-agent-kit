/**
 * Message queue for walkie extension.
 *
 * Holds messages that arrive while the agent is busy (streaming).
 * After each agent_end, the queue drains the next message to trigger
 * a new run — preventing race conditions and followUp collisions.
 */

export interface QueuedMessage {
	text: string;
	messageId: number;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

export class MessageQueue {
	private items: QueuedMessage[] = [];

	/** Add a message to the end of the queue. */
	push(msg: QueuedMessage): void {
		this.items.push(msg);
	}

	/** Remove and return the next message, or undefined if empty. */
	shift(): QueuedMessage | undefined {
		return this.items.shift();
	}

	/** Number of queued messages. */
	get length(): number {
		return this.items.length;
	}

	/** True if there are messages waiting. */
	get pending(): boolean {
		return this.items.length > 0;
	}

	/** Discard all queued messages. */
	clear(): void {
		this.items = [];
	}
}
