/**
 * Pi ICM Hook — native extension wrapping ICM CLI
 *
 * Provides persistent memory via ICM (Infinite Context Memory) as Pi tools
 * and lifecycle hooks. Ported from hermes-icm-memory (Python) to TypeScript.
 *
 * Tools: icm_recall, icm_store, icm_update, icm_forget, icm_consolidate,
 *        icm_health, icm_topics, icm_stats
 *
 * Lifecycle:
 *   session_start          — check ICM availability
 *   before_agent_start     — recall memories + inject directive into system prompt
 *   message_end            — trigger detection (auto-store) + footer indicator
 *   session_before_compact — save context before compaction truncation
 *   session_shutdown       — cleanup
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execFile } from "child_process";
import { basename } from "path";

// ─── Config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
	recallLimit: 5,
	prefetchEnabled: true,
	defaultImportance: "high",
	readTimeoutMs: 3000,
	writeTimeoutMs: 5000,
	indicatorEnabled: true,
};

// ─── Types ────────────────────────────────────────────────────────────

interface ICMHit {
	id: string;
	topic: string;
	content: string;
	summary?: string;
	importance: string;
	keywords?: string[];
	score?: number;
	created_at?: string;
}

interface Trigger {
	topic: string;
	content: string;
	importance: "critical" | "high" | "medium" | "low";
	keywords: string[];
}

interface SessionState {
	available: boolean;
	checked: boolean;
	project: string;
	turnIndex: number;
	recallCount: number;
	recallTopic: string | null;
	lastSaveTopic: string | null;
	userPrompt: string;
}

// ─── CLI Runner ───────────────────────────────────────────────────────

function runICM(args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"icm",
			args,
			{ timeout: timeoutMs, maxBuffer: 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error(stderr?.trim() || err.message));
					return;
				}
				resolve(stdout.trim());
			},
		);
	});
}

// For fire-and-forget invocations — discard errors
async function safeRunICM(
	args: string[],
	timeoutMs: number,
): Promise<string | null> {
	try {
		return await runICM(args, timeoutMs);
	} catch {
		return null;
	}
}


// ─── Trigger Detection ────────────────────────────────────────────────
// Ported from Hermes hermes_icm_memory/mapping.py

const TRIGGER_PATTERNS: Array<{
	name: string;
	topicTpl: string;
	importance: Trigger["importance"];
	detect: (user: string, assistant: string) => boolean;
}> = [
	{
		name: "error-resolved",
		topicTpl: "errors-resolved-{p}",
		importance: "high",
		detect: (user, asst) =>
			/error|bug|exception|traceback|panic|fail(ed|ure)?|crash/i.test(
				user,
			) &&
			/fix(ed|es)?|resolved|work.?around|root.?cause|solution|patch/i.test(
				asst,
			),
	},
	{
		name: "decision",
		topicTpl: "decisions-{p}",
		importance: "high",
		detect: (user, asst) =>
			/decid(e|ed|sion)|chose|went with|architect|design|approach|strategy/i.test(
				user + " " + asst,
			) &&
			/we('ll| will)? (use|go with|implement|adopt)|decided (to|on)|let's|went with/i.test(
				asst,
			),
	},
	{
		name: "preference",
		topicTpl: "preferences",
		importance: "critical",
		detect: (user) =>
			/\b(prefer|always|never|must|should|don't like|require|ensure)\b/i.test(
				user,
			),
	},
	{
		name: "learning",
		topicTpl: "learnings-{p}",
		importance: "medium",
		detect: (_user, asst) =>
			/\b(learn(ed|ing)?|insight|turns out|actually|note that|important|discovered)\b/i.test(
				asst,
			),
	},
	{
		name: "gotcha",
		topicTpl: "gotchas-{p}",
		importance: "high",
		detect: (_user, asst) =>
			/\b(gotcha|pitfall|watch out|beware|careful|don't forget|caveat)\b/i.test(
				asst,
			),
	},
];

function detectTriggers(
	user: string,
	assistant: string,
	project: string,
): Trigger[] {
	const triggers: Trigger[] = [];
	for (const p of TRIGGER_PATTERNS) {
		if (p.detect(user, assistant)) {
			triggers.push({
				topic: p.topicTpl.replace("{p}", project),
				content: summarize(assistant, 400),
				importance: p.importance,
				keywords: kw(`${user} ${assistant}`),
			});
		}
	}
	return triggers;
}

function summarize(text: string, max: number): string {
	const lines = text
		.split("\n")
		.filter((l) => l.trim().length > 10 && !l.startsWith("```"));
	const s = lines
		.slice(0, 4)
		.join(" ")
		.replace(/[*#`]/g, "")
		.trim();
	return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

const STOP = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"not",
	"no",
	"can",
	"just",
	"about",
	"also",
	"really",
	"need",
	"want",
	"like",
	"know",
	"think",
	"make",
	"going",
	"what",
	"which",
	"who",
	"how",
	"when",
	"where",
	"why",
	"all",
	"each",
	"more",
	"most",
	"other",
	"some",
	"such",
	"than",
	"too",
	"very",
	"using",
	"used",
	"use",
	"into",
	"here",
	"there",
	"then",
	"being",
	"doesnt",
	"dont",
]);

function kw(text: string): string[] {
	const words = text
		.toLowerCase()
		.split(/\W+/)
		.filter((w) => w.length > 3 && !STOP.has(w));
	const freq = new Map<string, number>();
	for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
	return [...freq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([w]) => w);
}

// ─── Formatters ───────────────────────────────────────────────────────

function formatHits(hits: ICMHit[], limit: number): string {
	if (!hits.length) return "";
	const capped = hits.slice(0, limit);
	const lines: string[] = ["Recalled memories:"];
	const topics: string[] = [];
	const seen = new Set<string>();
	for (const h of capped) {
		const topic = h.topic || "?";
		const summary = h.summary || h.content || "";
		lines.push(`  - [${topic}] ${summary}`.slice(0, 200));
		if (topic !== "?" && !seen.has(topic)) {
			seen.add(topic);
			topics.push(topic);
		}
	}
	const ctx = topics.length ? `\n  Topics: ${topics.join(", ")}` : "";
	return (
		lines.join("\n") +
		ctx +
		"\n\nWhen referencing recalled memories, keep it brief. If nothing relevant, stay silent."
	);
}

function formatRecallLabel(recallCount: number, recallTopic: string | null): string {
	if (recallCount <= 0) return "📚 —";
	return recallTopic ? `📚 ${recallCount} ${recallTopic}` : `📚 ${recallCount}`;
}

function renderDirective(
	recallCount: number,
	recallTopic: string | null,
): string {
	return [
		`ICM memory active (${recallCount} recalled).`,
		"If this exchange is worth remembering, call icm_store with a concise summary.",
		"Save-worthy: decisions, fixes, preferences, learnings, gotchas, status updates.",
		`End reply with footer: ${formatRecallLabel(recallCount, recallTopic)} · 💾 <topic if saved, — if not>`,
	].join("\n");
}

const FOOTER_RE = /\n*📚[^\n]*·[^\n]*💾[^\n]*$/;

function renderFooter(
	recallCount: number,
	recallTopic: string | null,
	saveTopic: string | null,
): string {
	const s = saveTopic ? `💾 ${saveTopic}` : "💾 —";
	return `${formatRecallLabel(recallCount, recallTopic)} · ${s}`;
}

// ─── Message helpers ──────────────────────────────────────────────────

function getTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text || "")
			.join("\n");
	}
	return "";
}

function appendFooterToContent(content: unknown, footer: string): unknown {
	if (typeof content === "string") {
		const cleaned = content.replace(FOOTER_RE, "").trim();
		return `${cleaned}\n\n${footer}`;
	}
	if (Array.isArray(content)) {
		const blocks = [...content];
		let lastTextIdx = -1;
		for (let i = blocks.length - 1; i >= 0; i--) {
			if (blocks[i].type === "text") {
				lastTextIdx = i;
				break;
			}
		}
		if (lastTextIdx >= 0) {
			const cleaned = (blocks[lastTextIdx].text || "")
				.replace(FOOTER_RE, "")
				.trim();
			blocks[lastTextIdx] = {
				...blocks[lastTextIdx],
				text: `${cleaned}\n\n${footer}`,
			};
		} else {
			blocks.push({ type: "text", text: footer });
		}
		return blocks;
	}
	return content;
}

// ─── Extension ────────────────────────────────────────────────────────

export default function icmExtension(pi: ExtensionAPI) {
	const state: SessionState = {
		available: false,
		checked: false,
		project: basename(process.cwd()),
		turnIndex: 0,
		recallCount: 0,
		recallTopic: null,
		lastSaveTopic: null,
		userPrompt: "",
	};

	const config = { ...DEFAULT_CONFIG };

	// ── Availability check ────────────────────────────────────────────

	async function ensureAvailable(): Promise<boolean> {
		if (state.checked) return state.available;
		const result = await safeRunICM(["stats"], config.readTimeoutMs);
		state.available = result !== null;
		state.checked = true;
		return state.available;
	}

	// ──────────────────────────────────────────────────────────────────
	// TOOLS
	// ──────────────────────────────────────────────────────────────────

	// icm_recall
	pi.registerTool({
		name: "icm_recall",
		label: "ICM Recall",
		description:
			"Search ICM memories. Returns matching memories ranked by relevance.",
		promptSnippet: "Search persistent memory for relevant context",
		promptGuidelines: [
			"Use icm_recall when you need to search long-term memory for context about past decisions, preferences, errors, or learnings.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			topic: Type.Optional(
				Type.String({ description: "Filter by topic" }),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max results (default 5)",
					default: 5,
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const args = [
				"recall",
				params.query,
				"--format",
				"json",
				"--limit",
				String(params.limit),
			];
			if (params.topic) args.push("-t", params.topic);
			const raw = await safeRunICM(args, config.readTimeoutMs);
			if (!raw) {
				return {
					content: [
						{
							type: "text" as const,
							text: "ICM recall unavailable.",
						},
					],
				};
			}
			try {
				const hits: ICMHit[] = JSON.parse(raw);
				if (!hits.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No memories found.",
							},
						],
					};
				}
				const formatted = hits
					.map(
						(h) =>
							`[${h.topic}] (importance: ${h.importance}) ${h.summary || h.content}`,
					)
					.join("\n");
				return {
					content: [
						{ type: "text" as const, text: formatted },
					],
				};
			} catch {
				return {
					content: [{ type: "text" as const, text: raw }],
				};
			}
		},
	});

	// icm_store
	pi.registerTool({
		name: "icm_store",
		label: "ICM Store",
		description:
			"Store a memory in ICM. Use kebab-case topics (e.g. decisions-myproject, errors-resolved-foo).",
		promptSnippet: "Store a fact or insight to persistent memory",
		promptGuidelines: [
			"Use icm_store to persist decisions, resolved errors, user preferences, learnings, gotchas, or project status updates worth resuming from later.",
		],
		parameters: Type.Object({
			topic: Type.String({
				description: "Topic/category (kebab-case, e.g. decisions-myproject)",
			}),
			content: Type.String({
				description: "Memory content (concise, <=400 chars)",
			}),
			importance: StringEnum(["critical", "high", "medium", "low"] as const, {
				description: "Importance level",
				default: "high",
			}),
			keywords: Type.Optional(
				Type.String({
					description: "Keywords (comma-separated)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const args = [
				"store",
				"-t",
				params.topic,
				"-c",
				params.content.slice(0, 400),
				"-i",
				params.importance,
			];
			if (params.keywords) args.push("-k", params.keywords);
			try {
				const raw = await runICM(args, config.writeTimeoutMs);
				state.lastSaveTopic = params.topic;
				return {
					content: [
						{
							type: "text" as const,
							text: `Stored: ${params.topic}`,
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{ type: "text" as const, text: `ICM store failed: ${(e as Error).message}` },
					],
				};
			}
		},
	});

	// icm_update
	pi.registerTool({
		name: "icm_update",
		label: "ICM Update",
		description: "Update an existing ICM memory by ID.",
		promptSnippet: "Edit an existing memory in place",
		parameters: Type.Object({
			id: Type.String({ description: "Memory ID to update (a specific numeric/UUID entry ID — NOT a topic name; use icm_forget with topic= to bulk-delete a topic)" }),
			content: Type.String({
				description: "New content (replaces existing)",
			}),
			importance: Type.Optional(
				StringEnum(
					["critical", "high", "medium", "low"] as const,
					{ description: "New importance level" },
				),
			),
			keywords: Type.Optional(
				Type.String({
					description: "New keywords (comma-separated)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const args = ["update", "-c", params.content, params.id];
			if (params.importance) args.push("-i", params.importance);
			if (params.keywords) args.push("-k", params.keywords);
			try {
				const raw = await runICM(args, config.writeTimeoutMs);
				return {
					content: [
						{
							type: "text" as const,
							text: `Updated: ${params.id}`,
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{ type: "text" as const, text: `ICM update failed: ${(e as Error).message}` },
					],
				};
			}
		},
	});

	// icm_forget
	pi.registerTool({
		name: "icm_forget",
		label: "ICM Forget",
		description:
			"Delete a memory by ID, or all memories in a topic.",
		promptSnippet: "Delete a memory or clear a topic",
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({ description: "Memory ID to delete (a specific numeric/UUID entry ID — use topic= instead to delete all memories in a topic)" }),
			),
			topic: Type.Optional(
				Type.String({
					description: "Delete all memories in this topic",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			if (!params.id && !params.topic) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Provide either id or topic.",
						},
					],
				};
			}
			const args = ["forget"];
			if (params.id) args.push(params.id);
			if (params.topic) args.push("-t", params.topic);
			try {
				const raw = await runICM(args, config.writeTimeoutMs);
				return {
					content: [
						{
							type: "text" as const,
							text: `Forgot: ${params.id || params.topic}`,
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `ICM forget failed: ${(e as Error).message}`,
						},
					],
				};
			}
		},
	});

	// icm_consolidate
	pi.registerTool({
		name: "icm_consolidate",
		label: "ICM Consolidate",
		description:
			"Consolidate all memories of a topic into a single summary.",
		promptSnippet: "Merge all memories in a topic into one summary",
		parameters: Type.Object({
			topic: Type.String({ description: "Topic to consolidate" }),
			keep_originals: Type.Optional(
				Type.Boolean({
					description: "Keep original memories",
					default: false,
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const args = ["consolidate", "-t", params.topic];
			if (params.keep_originals) args.push("--keep-originals");
			try {
				const raw = await runICM(
					args,
					config.writeTimeoutMs * 2,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Consolidated: ${params.topic}`,
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `ICM consolidate failed: ${(e as Error).message}`,
						},
					],
				};
			}
		},
	});

	// icm_health
	pi.registerTool({
		name: "icm_health",
		label: "ICM Health",
		description:
			"Show ICM memory health report (staleness, consolidation needs).",
		promptSnippet: "Check memory health and staleness",
		parameters: Type.Object({
			topic: Type.Optional(
				Type.String({ description: "Check specific topic" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const args = ["health"];
			if (params.topic) args.push("-t", params.topic);
			const raw = await safeRunICM(args, config.readTimeoutMs);
			return {
				content: [
					{
						type: "text" as const,
						text: raw || "ICM health check unavailable.",
					},
				],
			};
		},
	});

	// icm_topics
	pi.registerTool({
		name: "icm_topics",
		label: "ICM Topics",
		description: "List all ICM memory topics.",
		promptSnippet: "List all memory topics",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const raw = await safeRunICM(["topics"], config.readTimeoutMs);
			return {
				content: [
					{
						type: "text" as const,
						text: raw || "ICM topics unavailable.",
					},
				],
			};
		},
	});

	// icm_stats
	pi.registerTool({
		name: "icm_stats",
		label: "ICM Stats",
		description: "Show ICM global memory statistics.",
		promptSnippet: "Show memory statistics",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const raw = await safeRunICM(["stats"], config.readTimeoutMs);
			return {
				content: [
					{
						type: "text" as const,
						text: raw || "ICM stats unavailable.",
					},
				],
			};
		},
	});

	// ──────────────────────────────────────────────────────────────────
	// EVENT HANDLERS
	// ──────────────────────────────────────────────────────────────────

	// ── Session Start — check availability ─────────────────────────────

	pi.on("session_start", async () => {
		await ensureAvailable();
	});

	// ── Before Agent Start — recall + directive injection ──────────────

	pi.on("before_agent_start", async (event) => {
		if (!state.available && !(await ensureAvailable())) return;

		// Store user prompt for trigger detection in message_end
		state.userPrompt = event.prompt || "";
		state.lastSaveTopic = null;
		state.turnIndex = 0;

		if (!config.prefetchEnabled) {
			const directive = renderDirective(0, null);
			return {
				systemPrompt: event.systemPrompt + "\n\n" + directive,
			};
		}

		// Recall using user prompt (or project name as fallback)
		const query = state.userPrompt || state.project;
		try {
			const raw = await runICM(
				[
					"recall",
					query,
					"--format",
					"json",
					"--limit",
					String(config.recallLimit),
				],
				config.readTimeoutMs,
			);
			let hits: ICMHit[] = [];
			try {
				hits = JSON.parse(raw);
			} catch {
				// Not valid JSON — treat as no results
			}
			state.recallCount = hits.length;
			state.recallTopic =
				hits.length > 0 ? hits[0].topic || null : null;

			const block = formatHits(hits, config.recallLimit);
			const directive = renderDirective(
				state.recallCount,
				state.recallTopic,
			);
			const injection = block
				? `${block}\n\n${directive}`
				: directive;
			return {
				systemPrompt: event.systemPrompt + "\n\n" + injection,
			};
		} catch {
			// Degraded — no recall, still inject directive
			const directive = renderDirective(0, null);
			return {
				systemPrompt: event.systemPrompt + "\n\n" + directive,
			};
		}
	});

	// ── Message End — trigger detection + footer ───────────────────────

	pi.on("message_end", async (event) => {
		if (!state.available) return;

		const msg = event.message;
		if (msg.role !== "assistant") return;

		const text = getTextContent(msg.content);
		if (!text || text.length < 20) return;

		// Trigger detection
		const triggers = detectTriggers(
			state.userPrompt,
			text,
			state.project,
		);
		for (const t of triggers) {
			const args = [
				"store",
				"-t",
				t.topic,
				"-c",
				t.content.slice(0, 400),
				"-i",
				t.importance,
			];
			if (t.keywords.length)
				args.push("-k", t.keywords.join(","));
			// Fire-and-forget — don't block message rendering
			safeRunICM(args, config.writeTimeoutMs).then((ok) => {
				if (ok) state.lastSaveTopic = t.topic;
			});
		}

		// Footer injection
		if (!config.indicatorEnabled) return;

		const footer = renderFooter(
			state.recallCount,
			state.recallTopic,
			state.lastSaveTopic,
		);
		return {
			message: {
				...msg,
				content: appendFooterToContent(msg.content, footer),
			},
		};
	});

	// ── Session Before Compact — save context before truncation ────────

	pi.on("session_before_compact", async () => {
		if (!state.available) return;
		try {
			await runICM(
				[
					"store",
					"-t",
					`context-${state.project}`,
					"-c",
					`Pre-compact save: ${new Date().toISOString()}. ${state.turnIndex} turns completed in this session.`,
					"-i",
					"medium",
				],
				config.writeTimeoutMs,
			);
		} catch {
			// Non-critical — degrade silently
		}
	});

	// ── Session Shutdown ───────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		// Stores are fire-and-forget, nothing to drain.
		// Reset state for potential reuse.
		state.checked = false;
		state.available = false;
	});
}
