/**
 * Claude Memory Extension
 *
 * Gives pi read and write access to Claude Code's auto-memory store — the
 * same `~/.claude/projects/<cwd-slug>/memory/` directory Claude Code uses.
 * One store, two agents, no sync step.
 *
 * Mirrors Claude Code's own two-tier design: the `MEMORY.md` index is injected
 * into the system prompt once per session, and bodies are fetched on demand
 * with `memory_read`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	generateDiffString,
	keyHint,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import path from "node:path";

import {
	applyMemoryWrite,
	buildMemoryPrompt,
	listMemories,
	memoryDeletedSummary,
	memoryDirFor,
	memorySummary,
	readMemory,
} from "./memory-core.ts";

export default function (pi: ExtensionAPI) {
	let injected = false;

	pi.on("session_start", async () => {
		injected = false;
	});

	// Inject the index once per session, not once per turn — the store does not
	// change often, and re-injecting would grow the prompt on every exchange.
	pi.on("before_agent_start", async (event, ctx) => {
		if (injected) return;
		injected = true;

		const prompt = buildMemoryPrompt(memoryDirFor(ctx.cwd));
		if (!prompt) return;

		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.registerTool({
		name: "memory_read",
		label: "Read memory",
		description:
			"Read one memory from the store shared with Claude Code. Takes the memory name — " +
			"the filename without the .md extension, as listed in the injected memory index.",
		promptSnippet: "Read a stored memory by name",
		promptGuidelines: [
			"Call memory_read when an entry in the memory index looks relevant to the current task.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Memory name, e.g. no-claude-pr-signature" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = memoryDirFor(ctx.cwd);
			try {
				const memory = readMemory(dir, params.name);
				if (!memory) {
					const known = listMemories(dir).map((m) => m.name);
					return {
						content: [
							{
								type: "text" as const,
								text: known.length
									? `No memory named "${params.name}". Available: ${known.join(", ")}`
									: `No memory named "${params.name}". The store is empty.`,
							},
						],
						details: {},
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `${memory.description}\n\n${memory.body}`,
						},
					],
					details: {
						name: memory.name,
						type: memory.type,
						description: memory.description,
						body: memory.body,
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `${(error as Error).message}` }],
					details: {},
				};
			}
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
			const details = result.details as
				| { name?: string; description?: string; body?: string }
				| undefined;

			const collapsed = theme.fg(
				"success",
				`${details?.name ?? "memory"}: ${details?.description ?? ""}`,
			);
			if (!expanded || !details?.body) {
				return new Text(
					`${collapsed} ${theme.fg("dim", `(${keyHint("app.tools.expand", "expand")})`)}`,
					0,
					0,
				);
			}
			return new Text(`${collapsed}\n${theme.fg("dim", details.body)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "memory_write",
		label: "Write memory",
		description:
			"Save a durable fact to the memory store shared with Claude Code. Use for preferences, " +
			"project constraints, and guidance you were given — not for things the repo or git " +
			"history already records, and not for details that only matter in this conversation. " +
			"To delete a memory, pass an empty body (\"\"); a null body and the literal text " +
			"\"null\" are accepted as the same request.",
		promptSnippet: "Save a durable fact to shared memory",
		promptGuidelines: [
			"Call memory_write when the user states a lasting preference or correction worth keeping across sessions.",
			"Call memory_write with an empty body to delete a memory that is no longer wanted.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short kebab-case slug, e.g. prefers-tabs-over-spaces" }),
			description: Type.Optional(
				Type.String({
					description:
						"One line summarizing the fact. Used to decide relevance during recall. " +
						"Omit when deleting.",
				}),
			),
			body: Type.Optional(
				Type.Union([
					Type.String({
						description:
							"The fact itself. For feedback and project types, follow with **Why:** and " +
							"**How to apply:** lines. Pass an empty string to delete the memory; " +
							"null and the literal text \"null\" are treated the same way.",
					}),
					Type.Null({
						description: "Same as an empty string: delete the memory.",
					}),
				]),
			),
			type: Type.Optional(
				Type.String({ description: "One of: user, feedback, project, reference" }),
			),
			title: Type.Optional(Type.String({ description: "Index title. Defaults to the name." })),
			hook: Type.Optional(
				Type.String({ description: "Short index hook. Defaults to the description." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = memoryDirFor(ctx.cwd);

			// memory_write mutates MEMORY.md read-modify-write, so two calls in one
			// turn would race and lose an index line without this queue.
			return withFileMutationQueue(path.join(dir, "MEMORY.md"), async () => {
				try {
					// The body decides the action: a body that carries no content
					// deletes the memory, anything else is stored. The store layer
					// makes that call, so a delete can never be reported as an
					// update — including when the body arrives as the literal
					// text "null" instead of a JSON null.
					const outcome = applyMemoryWrite(dir, params);

					if (outcome.action === "deleted") {
						return {
							content: [
								{
									type: "text" as const,
									text: memoryDeletedSummary(params.name, outcome.existed),
								},
							],
							details: { name: params.name, dir, deleted: true, existed: outcome.existed },
						};
					}

					const { memory, previous, created } = outcome;
					const diff =
						previous === null
							? undefined
							: generateDiffString(previous.body, memory.body).diff;
					return {
						content: [
							{ type: "text" as const, text: memorySummary(params.name, created) },
						],
						details: {
							name: params.name,
							dir,
							created,
							diff,
							body: memory.body,
						},
					};
				} catch (error) {
					return {
						content: [
							{ type: "text" as const, text: `Could not save: ${(error as Error).message}` },
						],
						details: {},
					};
				}
			});
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);
			const details = result.details as
				| {
						name?: string;
						created?: boolean;
						diff?: string;
						body?: string;
						deleted?: boolean;
						existed?: boolean;
				  }
				| undefined;

			if (!details?.name) {
				const content = result.content[0];
				return new Text(
					theme.fg("error", content?.type === "text" ? content.text : "Failed"),
					0,
					0,
				);
			}

			if (details.deleted) {
				const text = memoryDeletedSummary(details.name, details.existed ?? false);
				return new Text(
					theme.fg(details.existed ? "success" : "warning", text),
					0,
					0,
				);
			}

			const summary = theme.fg(
				"success",
				memorySummary(details.name, details.created ?? true),
			);

			if (!expanded) {
				return new Text(
					`${summary} ${theme.fg("dim", `(${keyHint("app.tools.expand", "expand")})`)}`,
					0,
					0,
				);
			}

			// Show a diff when updating an existing memory, otherwise the new body.
			if (details.diff) {
				const lines = details.diff.split("\n").slice(0, 30);
				let text = summary;
				for (const line of lines) {
					if (line.startsWith("+")) {
						text += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-")) {
						text += `\n${theme.fg("error", line)}`;
					} else {
					text += `\n${theme.fg("dim", line)}`;
				}
				}
				const total = details.diff.split("\n").length;
				if (total > 30) {
					text += `\n${theme.fg("muted", `... ${total - 30} more diff lines`)}`;
				}
				return new Text(text, 0, 0);
			}

			return new Text(`${summary}\n${theme.fg("dim", details.body ?? "")}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "memory_list",
		label: "List memories",
		description:
			"List every memory in the store shared with Claude Code, with its description. " +
			"Use when the injected index looks incomplete or stale.",
		promptSnippet: "List all stored memories",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const memories = listMemories(memoryDirFor(ctx.cwd));
			return {
				content: [
					{
						type: "text" as const,
						text: memories.length
							? memories.map((m) => `- ${m.name} — ${m.description}`).join("\n")
							: "No memories stored for this project.",
					},
				],
				details: { count: memories.length },
			};
		},
	});
}
