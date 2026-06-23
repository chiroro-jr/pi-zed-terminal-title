import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TITLE = "Pi";
const MAX_TITLE_LENGTH = 52;
const TITLE_MODEL_SETTING = "terminalThreadTitleModel";
const TITLE_ENTRY_TYPE = "zed-terminal-title";

let taskTitle = DEFAULT_TITLE;
let titleResolved = false;
let configuredTitleModel: string | undefined;
let currentStatus: "idle" | "working" = "idle";
let titleGenerationId = 0;

function writeTerminalTitle(title: string) {
	// OSC 0/2: set terminal/window title. Zed Terminal Threads read this.
	process.stdout.write(`\x1b]0;${title}\x07`);
}

function notifyTerminal() {
	// BEL: Zed uses this for Terminal Thread notifications when not focused.
	process.stdout.write("\x07");
}

function localFallbackTitle(prompt: string | undefined): string {
	const normalized = (prompt ?? "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!normalized) return DEFAULT_TITLE;

	const firstLine = normalized.replace(/[.?!:;,\-–—]+$/g, "").split(/[\r\n]/)[0]?.trim() ?? DEFAULT_TITLE;
	if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;

	const cut = firstLine.slice(0, MAX_TITLE_LENGTH - 1);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function normalizeAiTitle(title: string): string {
	const cleaned = title
		.replace(/^['"`]+|['"`]+$/g, "")
		.replace(/\s+/g, " ")
		.replace(/[\r\n]+/g, " ")
		.trim();

	if (!cleaned) return DEFAULT_TITLE;
	if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned;

	const cut = cleaned.slice(0, MAX_TITLE_LENGTH - 1);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function loadJson(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;

	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function readTitleModelSetting(): string | undefined {
	const home = process.env.HOME ?? "";
	const globalSettings = loadJson(join(home, ".pi", "agent", "settings.json"));
	const projectSettings = loadJson(join(process.cwd(), ".pi", "settings.json"));
	const setting = projectSettings?.[TITLE_MODEL_SETTING] ?? globalSettings?.[TITLE_MODEL_SETTING];

	return typeof setting === "string" && setting.trim() ? setting.trim() : undefined;
}

function parseConfiguredTitleModel(modelRegistry: { find(provider: string, id: string): unknown }, raw: string | undefined) {
	if (!raw) return undefined;

	const [provider, ...rest] = raw.split("/");
	const id = rest.join("/");
	if (!provider || !id) return undefined;

	return modelRegistry.find(provider, id) ?? undefined;
}

function statusTitle(status: "idle" | "working") {
	const icon = status === "working" ? "⏳️" : "✅";
	return `${icon} ${taskTitle}`;
}

function textFromContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;

	const text = content
		.filter((block): block is { type: "text"; text: string } => {
			const candidate = block as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();

	return text || undefined;
}

function restoredTitleFromSession(ctx: { sessionManager: { getBranch(): unknown[] } }, sessionName: string | undefined) {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: { title?: unknown } };
		if (entry.type === "custom" && entry.customType === TITLE_ENTRY_TYPE && typeof entry.data?.title === "string") {
			return normalizeAiTitle(entry.data.title);
		}
	}

	if (sessionName?.trim()) return normalizeAiTitle(sessionName);

	for (const entry of branch) {
		const message = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
		if ((entry as { type?: string }).type === "message" && message?.role === "user") {
			const text = textFromContent(message.content);
			if (text) return localFallbackTitle(text);
		}
	}

	return undefined;
}

async function generateTaskTitle(
	prompt: string,
	ctx: {
		model?: unknown;
		modelRegistry: {
			find(provider: string, id: string): unknown;
			getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
		};
		signal: AbortSignal | undefined;
	},
) {
	const model = parseConfiguredTitleModel(ctx.modelRegistry, configuredTitleModel) ?? ctx.model;
	if (!model) return null;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;

	const messages: Message[] = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: `Write a short terminal thread title for this request.\n\nRules:\n- 2 to 6 words\n- title case is fine\n- no quotes\n- no trailing punctuation\n- no "Pi", "working", or "idle"\n- keep the core task, not the implementation details\n\nRequest:\n${prompt}`,
				},
			],
			timestamp: Date.now(),
		},
	];

	const response = await complete(
		model,
		{ messages },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: ctx.signal,
		},
	);

	if (response.stopReason === "aborted") return null;

	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");

	return normalizeAiTitle(text);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		taskTitle = restoredTitleFromSession(ctx, pi.getSessionName()) ?? DEFAULT_TITLE;
		titleResolved = taskTitle !== DEFAULT_TITLE;
		configuredTitleModel = undefined;
		currentStatus = "idle";
		titleGenerationId++;
		writeTerminalTitle(statusTitle(currentStatus));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		currentStatus = "working";

		if (titleResolved) {
			writeTerminalTitle(statusTitle(currentStatus));
			return;
		}

		configuredTitleModel = readTitleModelSetting();
		taskTitle = localFallbackTitle(event.prompt);
		writeTerminalTitle(statusTitle(currentStatus));

		const prompt = event.prompt;
		const generationId = ++titleGenerationId;
		void (async () => {
			try {
				const aiTitle = await generateTaskTitle(prompt, ctx);
				if (!aiTitle || generationId !== titleGenerationId) return;

				taskTitle = aiTitle;
				titleResolved = true;
				pi.appendEntry(TITLE_ENTRY_TYPE, { title: aiTitle });
				writeTerminalTitle(statusTitle(currentStatus));
			} catch {
				// Keep the local fallback title if AI title generation fails.
			}
		})();
	});

	pi.on("agent_end", () => {
		currentStatus = "idle";
		writeTerminalTitle(statusTitle(currentStatus));
		notifyTerminal();
	});

	pi.on("session_shutdown", () => {
		taskTitle = DEFAULT_TITLE;
		titleResolved = false;
		configuredTitleModel = undefined;
		currentStatus = "idle";
		titleGenerationId++;
		writeTerminalTitle(statusTitle(currentStatus));
	});
}
