/**
 * Core logic for reading and writing Claude Code's auto-memory store.
 *
 * Claude Code keeps one memory per file under
 * `~/.claude/projects/<slugified-cwd>/memory/`, alongside a `MEMORY.md`
 * index that holds one pointer line per memory. Only the index is loaded
 * at session start; bodies are read on demand. This module reproduces
 * that layout exactly so pi and Claude Code share a single store.
 *
 * Pure functions plus thin fs wrappers — no pi imports, so it is testable
 * with plain `node --test`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface IndexEntry {
	title: string;
	file: string;
	hook: string;
}

export interface Memory {
	name: string;
	description: string;
	type: string;
	body: string;
}

export interface WriteMemoryInput {
	name: string;
	description?: string;
	body: string;
	type?: string;
	title?: string;
	hook?: string;
}

const INDEX_FILE = "MEMORY.md";
const DEFAULT_TYPE = "project";

/** Claude Code slugifies the working directory by replacing `/` and `.` with `-`. */
export function memoryDirFor(cwd: string): string {
	const absolute = path.resolve(cwd);
	const slug = absolute.replace(/[/.]/g, "-");
	return path.join(os.homedir(), ".claude", "projects", slug, "memory");
}

/** Parse `- [Title](file.md) — hook` pointer lines, ignoring anything else. */
export function parseIndex(md: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	for (const line of md.split("\n")) {
		const match = /^\s*-\s*\[([^\]]*)\]\(([^)]+)\)\s*(?:—\s*(.*))?$/.exec(line);
		if (!match) continue;
		entries.push({
			title: match[1].trim(),
			file: match[2].trim(),
			hook: (match[3] ?? "").trim(),
		});
	}
	return entries;
}

function renderIndexLine(entry: IndexEntry): string {
	const hook = entry.hook.trim();
	return hook ? `- [${entry.title}](${entry.file}) — ${hook}` : `- [${entry.title}](${entry.file})`;
}

/** Replace the pointer line for `entry.file` if present, otherwise append it. */
export function upsertIndexLine(md: string, entry: IndexEntry): string {
	const rendered = renderIndexLine(entry);
	const lines = md.split("\n");
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

	let replaced = false;
	const next = lines.map((line) => {
		const parsed = parseIndex(line)[0];
		if (parsed && parsed.file === entry.file) {
			replaced = true;
			return rendered;
		}
		return line;
	});

	if (!replaced) next.push(rendered);
	return `${next.join("\n")}\n`;
}

/** Split a memory file into its frontmatter fields and body. */
export function parseMemory(text: string): Memory {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) {
		return { name: "", description: "", type: "", body: text.trim() };
	}

	const [, frontmatter, rest] = match;
	const field = (key: string): string => {
		const found = new RegExp(`^\\s*${key}:\\s*(.*)$`, "m").exec(frontmatter);
		return found ? found[1].trim() : "";
	};

	return {
		name: field("name"),
		description: field("description"),
		type: field("type"),
		body: rest.replace(/^\s*\n/, "").trimEnd(),
	};
}

/** Render a memory in the frontmatter shape Claude Code writes and reads. */
export function serializeMemory(input: {
	name: string;
	description: string;
	type?: string;
	body?: string;
}): string {
	return [
		"---",
		`name: ${input.name}`,
		`description: ${input.description}`,
		"metadata:",
		"  node_type: memory",
		`  type: ${input.type || DEFAULT_TYPE}`,
		"---",
		"",
		`${(input.body ?? "").trim()}\n`,
	].join("\n");
}

/**
 * Build the block injected into pi's system prompt: the index only, never the
 * bodies. This mirrors how Claude Code loads memory — a table of contents up
 * front, full text pulled on demand — so a large store stays cheap.
 *
 * Returns null when the directory holds no memories, so the caller can leave
 * the prompt untouched.
 */
export function buildMemoryPrompt(dir: string): string | null {
	const indexed = parseIndex(readIndex(dir));
	const lines = indexed.length
		? indexed.map((entry) => renderIndexLine(entry))
		: listMemories(dir).map((memory) =>
				renderIndexLine({
					title: memory.name,
					file: `${memory.name}.md`,
					hook: memory.description,
				}),
			);

	if (lines.length === 0) return null;

	return [
		"## Memory",
		"",
		"You share a persistent memory store with Claude Code for this project.",
		"Below is the index — one line per memory, bodies not included.",
		"",
		...lines,
		"",
		"Call `memory_read` with a name (the filename without `.md`) when an entry",
		"looks relevant to the task at hand. Call `memory_write` to record a durable",
		"fact — a preference, a project constraint, or guidance you were given.",
		"Do not record what the repo or git history already says.",
	].join("\n");
}

function assertSafeName(name: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
		throw new Error(
			`Invalid memory name "${name}": use a kebab-case slug with no path separators.`,
		);
	}
}

/** Every memory in the directory, sorted by name. Missing directory yields []. */
export function listMemories(dir: string): Memory[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((file) => file.endsWith(".md") && file !== INDEX_FILE)
		.sort()
		.map((file) => {
			const parsed = parseMemory(fs.readFileSync(path.join(dir, file), "utf8"));
			return { ...parsed, name: parsed.name || path.basename(file, ".md") };
		});
}

/** Read the index file verbatim, or "" when it does not exist yet. */
export function readIndex(dir: string): string {
	const file = path.join(dir, INDEX_FILE);
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

export function readMemory(dir: string, name: string): Memory | null {
	assertSafeName(name);
	const file = path.join(dir, `${name}.md`);
	if (!fs.existsSync(file)) return null;
	const parsed = parseMemory(fs.readFileSync(file, "utf8"));
	return { ...parsed, name: parsed.name || name };
}

export interface WriteMemoryResult {
	memory: Memory;
	previous: Memory | null;
	created: boolean;
}

/** Drop the pointer line for `file` from the index, preserving the rest. */
export function removeIndexLine(md: string, file: string): string {
	const kept = md.split("\n").filter((line) => {
		const parsed = parseIndex(line)[0];
		return !(parsed && parsed.file === file);
	});
	while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
	return kept.length ? `${kept.join("\n")}\n` : "";
}

/** One-line summary shown for a memory_write tool result. */
export function memorySummary(name: string, created: boolean): string {
	return created ? `Saved memory "${name}".` : `Updated memory "${name}".`;
}

/** One-line summary shown when memory_write deletes a memory. */
export function memoryDeletedSummary(name: string, existed: boolean): string {
	return existed ? `Deleted memory "${name}".` : `No memory named "${name}" to delete.`;
}

/**
 * Delete a memory: remove its file and drop its pointer line from the index.
 * The index file itself is removed when it empties, so an empty store stays
 * empty. Returns true when a memory file existed.
 */
export function deleteMemory(dir: string, name: string): boolean {
	assertSafeName(name);
	const file = path.join(dir, `${name}.md`);
	const existed = fs.existsSync(file);
	if (existed) fs.rmSync(file);

	const indexFile = path.join(dir, INDEX_FILE);
	if (fs.existsSync(indexFile)) {
		const cleaned = removeIndexLine(fs.readFileSync(indexFile, "utf8"), `${name}.md`);
		if (cleaned === "") fs.rmSync(indexFile);
		else fs.writeFileSync(indexFile, cleaned);
	}
	return existed;
}

/** Write (or overwrite) a memory and register it in the index. */
export function writeMemory(dir: string, input: WriteMemoryInput): WriteMemoryResult {
	assertSafeName(input.name);
	fs.mkdirSync(dir, { recursive: true });

	const previous = readMemory(dir, input.name);

	const memory: Memory = {
		name: input.name,
		// Omitted description keeps the previous one (or stays empty) — an update
		// that forgets the summary should not silently blank it.
		description: input.description?.trim() || previous?.description || "",
		type: input.type || DEFAULT_TYPE,
		body: input.body.trim(),
	};

	fs.writeFileSync(path.join(dir, `${input.name}.md`), serializeMemory(memory));

	const index = upsertIndexLine(readIndex(dir), {
		title: input.title?.trim() || input.name,
		file: `${input.name}.md`,
		hook: input.hook?.trim() || input.description || "",
	});
	fs.writeFileSync(path.join(dir, INDEX_FILE), index);

	return { memory, previous, created: previous === null };
}

/**
 * What a body argument means.
 *
 * `delete` — the body carries no content, so the memory is removed.
 * `update` — the body carries the fact to store, already trimmed.
 */
export type MemoryWriteIntent = { kind: "delete" } | { kind: "update"; body: string };

/**
 * Decide what a body argument means, before anything touches the store.
 *
 * A body that means "no body" must never reach the write path: it would
 * overwrite the memory with the literal text of the argument and report a
 * successful update. Several shapes carry no body — an omitted body, a JSON
 * null, an empty string, and a whitespace-only string — and so does the
 * four-character string "null", which is how some clients encode a null
 * body. That comparison is trimmed and case-insensitive, so " null " and
 * "NULL" are the same request too.
 *
 * Anything else is a body, including text that merely mentions the word,
 * such as "null pointer dereference".
 */
export function resolveWriteIntent(body: string | null | undefined): MemoryWriteIntent {
	if (body === undefined || body === null) return { kind: "delete" };
	if (typeof body !== "string") {
		throw new Error(`Invalid body: expected a string, null, or nothing, got ${typeof body}.`);
	}
	const trimmed = body.trim();
	if (trimmed === "") return { kind: "delete" };
	if (trimmed.toLowerCase() === "null") return { kind: "delete" };
	return { kind: "update", body: trimmed };
}

/** A memory_write request, as the tool receives it. */
export interface MemoryWriteRequest {
	name: string;
	description?: string;
	body?: string | null;
	type?: string;
	title?: string;
	hook?: string;
}

/** What a memory_write call did to the store. */
export type MemoryWriteOutcome =
	| { action: "deleted"; existed: boolean }
	| { action: "written"; memory: Memory; previous: Memory | null; created: boolean };

/**
 * Apply a memory_write request to the store.
 *
 * The body decides the action, and the decision is made once, here: a body
 * that means "no body" deletes the memory and can only ever report a
 * deletion, and every other body is stored and reported as a write. The
 * caller never gets to mistake one for the other.
 */
export function applyMemoryWrite(dir: string, request: MemoryWriteRequest): MemoryWriteOutcome {
	const intent = resolveWriteIntent(request.body);
	if (intent.kind === "delete") {
		return { action: "deleted", existed: deleteMemory(dir, request.name) };
	}

	const { memory, previous, created } = writeMemory(dir, {
		name: request.name,
		description: request.description,
		body: intent.body,
		type: request.type,
		title: request.title,
		hook: request.hook,
	});
	return { action: "written", memory, previous, created };
}
