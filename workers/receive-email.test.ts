import { describe, expect, it, vi } from "vitest";
import { receiveEmail } from "./index";
import type { Env } from "./types";
import type { MailboxDO } from "./durableObject";

function emailEvent(to: string, headerTo = "Original <original@example.net>, second@example.net") {
	const raw = new TextEncoder().encode([
		"From: Sender <sender@example.net>",
		`To: ${headerTo}`,
		"Cc: Copy <copy@example.net>",
		"Subject: Routing regression",
		"Message-ID: <routing@example.net>",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Original message body",
	].join("\r\n"));
	return {
		to,
		rawSize: raw.byteLength,
		raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
	};
}

function bindings(allowedAddresses?: string[], mailboxExists = true) {
	const mailbox = {
		findThreadBySubject: vi.fn().mockResolvedValue(null),
		createEmail: vi.fn<MailboxDO["createEmail"]>(),
	};
	const agent = { fetch: vi.fn<(request: Request) => Promise<Response>>().mockResolvedValue(new Response()) };
	const env = {
		EMAIL_ADDRESSES: allowedAddresses,
		BUCKET: { head: vi.fn().mockResolvedValue(mailboxExists ? {} : null), put: vi.fn() },
		MAILBOX: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => mailbox) },
		EMAIL_AGENT: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => agent) },
	};
	const pending: Promise<unknown>[] = [];
	const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => { pending.push(promise); }) };
	return {
		env, ctx, mailbox, agent,
		async receive(event: ReturnType<typeof emailEvent>) {
			await receiveEmail(event, env as unknown as Env, ctx as unknown as ExecutionContext);
			await Promise.all(pending);
		},
	};
}

describe("receiveEmail mailbox routing", () => {
	it.each([
		{ label: "unset", allowedAddresses: undefined },
		{ label: "empty", allowedAddresses: [] },
		{ label: "matching", allowedAddresses: ["INBOX@example.com"] },
	])(
		"routes forwarded mail with $label allowlist and preserves RFC recipients",
		async ({ allowedAddresses }) => {
			const { env, ctx, mailbox, agent, receive } = bindings(allowedAddresses);
			await receive(emailEvent("Inbox@Example.com"));

			expect(env.BUCKET.head).toHaveBeenCalledExactlyOnceWith("mailboxes/inbox@example.com.json");
			expect(env.MAILBOX.idFromName).toHaveBeenCalledExactlyOnceWith("inbox@example.com");
			expect(env.MAILBOX.get).toHaveBeenCalledExactlyOnceWith("inbox@example.com");
			expect(mailbox.createEmail).toHaveBeenCalledOnce();
			const [folder, storedEmail, attachments] = mailbox.createEmail.mock.calls[0];
			expect(folder).toBe("inbox");
			expect(storedEmail).toMatchObject({
				recipient: "original@example.net, second@example.net",
				cc: "copy@example.net",
				body: "Original message body\n",
				message_id: "routing@example.net",
			});
			expect(JSON.parse(storedEmail.raw_headers!)).toContainEqual({
				key: "to", value: "Original <original@example.net>, second@example.net",
			});
			expect(attachments).toEqual([]);
			expect(env.BUCKET.put).not.toHaveBeenCalled();
			expect(env.EMAIL_AGENT.idFromName).toHaveBeenCalledExactlyOnceWith("inbox@example.com");
			expect(env.EMAIL_AGENT.get).toHaveBeenCalledExactlyOnceWith("inbox@example.com");
			expect(ctx.waitUntil).toHaveBeenCalledOnce();
			expect(agent.fetch).toHaveBeenCalledOnce();
			expect(await agent.fetch.mock.calls[0][0].json()).toMatchObject({ mailboxId: "inbox@example.com" });
		},
	);

	it.each([
		{ label: "unset", allowedAddresses: undefined },
		{ label: "matching", allowedAddresses: ["inbox@example.com"] },
	])("preserves direct delivery with $label allowlist", async ({ allowedAddresses }) => {
		const { env, mailbox, receive } = bindings(allowedAddresses);
		await receive(emailEvent("inbox@example.com", "Inbox <inbox@example.com>"));
		expect(env.BUCKET.head).toHaveBeenCalledExactlyOnceWith("mailboxes/inbox@example.com.json");
		expect(env.MAILBOX.idFromName).toHaveBeenCalledExactlyOnceWith("inbox@example.com");
		expect(mailbox.createEmail).toHaveBeenCalledOnce();
		expect(mailbox.createEmail.mock.calls[0][1].recipient).toBe("inbox@example.com");
	});

	it("does not fall back to an allowed RFC To recipient", async () => {
		const { env, mailbox, agent, receive } = bindings(["original@example.net"]);
		await receive(emailEvent("inbox@example.com"));
		expect(env.BUCKET.head).not.toHaveBeenCalled();
		expect(env.MAILBOX.get).not.toHaveBeenCalled();
		expect(mailbox.createEmail).not.toHaveBeenCalled();
		expect(agent.fetch).not.toHaveBeenCalled();
	});

	it("ignores a missing envelope mailbox without looking up RFC To recipients", async () => {
		const { env, mailbox, agent, receive } = bindings(undefined, false);
		await receive(emailEvent("inbox@example.com"));
		expect(env.BUCKET.head).toHaveBeenCalledExactlyOnceWith("mailboxes/inbox@example.com.json");
		expect(env.MAILBOX.get).not.toHaveBeenCalled();
		expect(mailbox.createEmail).not.toHaveBeenCalled();
		expect(agent.fetch).not.toHaveBeenCalled();
	});

	it("rejects an empty envelope recipient without falling back to RFC To", async () => {
		const { env, receive } = bindings();
		await expect(receive(emailEvent(""))).rejects.toThrow("received email with no valid recipient address");
		expect(env.BUCKET.head).not.toHaveBeenCalled();
		expect(env.MAILBOX.get).not.toHaveBeenCalled();
	});
});
