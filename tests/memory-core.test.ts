import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	memoryDirFor,
	parseIndex,
	upsertIndexLine,
	parseMemory,
	serializeMemory,
	listMemories,
	readMemory,
	writeMemory,
	deleteMemory,
	removeIndexLine,
	buildMemoryPrompt,
	memorySummary,
	memoryDeletedSummary,
	resolveWriteIntent,
	applyMemoryWrite,
} from "../extensions/claude-memory/memory-core.ts";

function tmpdir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-memory-"));
}

test("memoryDirFor maps a cwd to Claude's project memory directory", () => {
	const dir = memoryDirFor("/Users/nicolas");
	assert.equal(dir, path.join(os.homedir(), ".claude/projects/-Users-nicolas/memory"));
});

test("memoryDirFor replaces dots as well as slashes", () => {
	// Claude Code slugifies /Users/dev/Source/my-app.git to
	// -Users-dev-Source-my-app-git
	const dir = memoryDirFor("/Users/dev/Source/my-app.git");
	assert.ok(dir.endsWith("/-Users-dev-Source-my-app-git/memory"));
});

test("memoryDirFor ignores a trailing slash", () => {
	assert.equal(memoryDirFor("/Users/nicolas/"), memoryDirFor("/Users/nicolas"));
});

test("parseIndex reads Claude's MEMORY.md pointer lines", () => {
	const md = [
		"- [No Claude PR signature](no-claude-pr-signature.md) — don't add Claude attribution",
		"- [Deploy runbook](deploy-runbook.md) — staging first, always",
	].join("\n");

	assert.deepEqual(parseIndex(md), [
		{
			title: "No Claude PR signature",
			file: "no-claude-pr-signature.md",
			hook: "don't add Claude attribution",
		},
		{ title: "Deploy runbook", file: "deploy-runbook.md", hook: "staging first, always" },
	]);
});

test("parseIndex tolerates blank lines and a missing hook", () => {
	const md = "\n- [Solo](solo.md)\n\n";
	assert.deepEqual(parseIndex(md), [{ title: "Solo", file: "solo.md", hook: "" }]);
});

test("upsertIndexLine appends a new entry", () => {
	const md = "- [A](a.md) — first\n";
	const out = upsertIndexLine(md, { title: "B", file: "b.md", hook: "second" });
	assert.equal(out, "- [A](a.md) — first\n- [B](b.md) — second\n");
});

test("upsertIndexLine replaces an existing entry by file, preserving order", () => {
	const md = "- [A](a.md) — first\n- [B](b.md) — second\n";
	const out = upsertIndexLine(md, { title: "A renamed", file: "a.md", hook: "updated" });
	assert.equal(out, "- [A renamed](a.md) — updated\n- [B](b.md) — second\n");
});

test("serializeMemory writes the frontmatter shape Claude Code expects", () => {
	const text = serializeMemory({
		name: "deploy-runbook",
		description: "How staging deploys work",
		type: "project",
		body: "Deploy to staging first.",
	});

	assert.match(text, /^---\n/);
	assert.match(text, /\nname: deploy-runbook\n/);
	assert.match(text, /\ndescription: How staging deploys work\n/);
	assert.match(text, /\n {2}type: project\n/);
	assert.ok(text.trimEnd().endsWith("Deploy to staging first."));
});

test("parseMemory round-trips serializeMemory", () => {
	const text = serializeMemory({
		name: "x",
		description: "d",
		type: "feedback",
		body: "body line",
	});
	const parsed = parseMemory(text);

	assert.equal(parsed.name, "x");
	assert.equal(parsed.description, "d");
	assert.equal(parsed.type, "feedback");
	assert.equal(parsed.body, "body line");
});

test("parseMemory keeps multi-line bodies intact", () => {
	const parsed = parseMemory("---\nname: n\ndescription: d\n---\n\nline one\n\nline two\n");
	assert.equal(parsed.body, "line one\n\nline two");
});

test("parseMemory on a file with no frontmatter yields an empty description", () => {
	const parsed = parseMemory("just a body");
	assert.equal(parsed.description, "");
	assert.equal(parsed.body, "just a body");
});

test("listMemories returns an empty list when the directory does not exist", () => {
	assert.deepEqual(listMemories(path.join(tmpdir(), "nope")), []);
});

test("listMemories excludes MEMORY.md itself", () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [A](a.md) — x\n");
	fs.writeFileSync(path.join(dir, "a.md"), serializeMemory({ name: "a", description: "d" }));

	assert.deepEqual(
		listMemories(dir).map((m) => m.name),
		["a"],
	);
});

test("writeMemory creates the file and registers it in the index", () => {
	const dir = tmpdir();
	writeMemory(dir, {
		name: "deploy-runbook",
		description: "How staging deploys work",
		type: "project",
		body: "Staging first.",
		title: "Deploy runbook",
		hook: "staging first, always",
	});

	const file = path.join(dir, "deploy-runbook.md");
	assert.ok(fs.existsSync(file));
	assert.equal(readMemory(dir, "deploy-runbook")?.body, "Staging first.");

	const index = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
	assert.equal(index, "- [Deploy runbook](deploy-runbook.md) — staging first, always\n");
});

test("writeMemory creates the memory directory when absent", () => {
	const dir = path.join(tmpdir(), "deep", "memory");
	writeMemory(dir, { name: "a", description: "d", body: "b" });
	assert.ok(fs.existsSync(path.join(dir, "a.md")));
});

test("writeMemory updates in place without duplicating the index line", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "first", body: "one", title: "A" });
	writeMemory(dir, { name: "a", description: "second", body: "two", title: "A" });

	const index = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
	assert.equal(index.match(/\(a\.md\)/g)?.length, 1);
	assert.equal(readMemory(dir, "a")?.description, "second");
	assert.equal(readMemory(dir, "a")?.body, "two");
});

test("writeMemory defaults the index title to the memory name", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "no-title-given", description: "d", body: "b" });
	const index = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
	assert.match(index, /- \[no-title-given\]\(no-title-given\.md\)/);
});

test("writeMemory rejects a name that escapes the memory directory", () => {
	const dir = tmpdir();
	assert.throws(() => writeMemory(dir, { name: "../escape", description: "d", body: "b" }), /name/i);
	assert.throws(() => writeMemory(dir, { name: "a/b", description: "d", body: "b" }), /name/i);
});

test("readMemory returns null for an unknown memory", () => {
	assert.equal(readMemory(tmpdir(), "missing"), null);
});

test("buildMemoryPrompt returns null when there are no memories", () => {
	assert.equal(buildMemoryPrompt(path.join(tmpdir(), "nope")), null);
});

test("buildMemoryPrompt includes the index and names the read tool", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "da", body: "ba", title: "A", hook: "ha" });

	const prompt = buildMemoryPrompt(dir);
	assert.ok(prompt);
	assert.match(prompt, /- \[A\]\(a\.md\) — ha/);
	assert.match(prompt, /memory_read/);
	assert.match(prompt, /memory_write/);
});

test("buildMemoryPrompt falls back to memory files when the index is missing", () => {
	const dir = tmpdir();
	fs.writeFileSync(
		path.join(dir, "orphan.md"),
		serializeMemory({ name: "orphan", description: "no index line exists" }),
	);

	const prompt = buildMemoryPrompt(dir);
	assert.ok(prompt);
	assert.match(prompt, /orphan/);
	assert.match(prompt, /no index line exists/);
});

test("writeMemory reports created=true with no previous for a new memory", () => {
	const dir = tmpdir();
	const out = writeMemory(dir, { name: "a", description: "d", body: "first" });
	assert.equal(out.created, true);
	assert.equal(out.previous, null);
	assert.equal(out.memory.body, "first");
});

test("writeMemory reports created=false with the previous body on update", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "d", body: "first" });
	const out = writeMemory(dir, { name: "a", description: "d", body: "second" });
	assert.equal(out.created, false);
	assert.equal(out.previous?.body, "first");
	assert.equal(out.memory.body, "second");
});

test("writeMemory keeps the previous description when description is omitted", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "original", body: "one" });
	writeMemory(dir, { name: "a", body: "two" });

	assert.equal(readMemory(dir, "a")?.description, "original");
	assert.equal(readMemory(dir, "a")?.body, "two");
});

test("memorySummary distinguishes save vs update", () => {
	assert.equal(memorySummary("deploy-runbook", true), 'Saved memory "deploy-runbook".');
	assert.equal(memorySummary("deploy-runbook", false), 'Updated memory "deploy-runbook".');
});

test("memoryDeletedSummary distinguishes delete vs missing", () => {
	assert.equal(memoryDeletedSummary("deploy-runbook", true), 'Deleted memory "deploy-runbook".');
	assert.equal(
		memoryDeletedSummary("deploy-runbook", false),
		'No memory named "deploy-runbook" to delete.',
	);
});

test("removeIndexLine drops the matching pointer line, preserving the rest", () => {
	const md = "- [A](a.md) — first\n- [B](b.md) — second\n";
	assert.equal(removeIndexLine(md, "a.md"), "- [B](b.md) — second\n");
});

test("removeIndexLine returns an empty string when the last line goes", () => {
	assert.equal(removeIndexLine("- [A](a.md) — first\n", "a.md"), "");
});

test("removeIndexLine leaves an index without the entry untouched", () => {
	const md = "- [B](b.md) — second\n";
	assert.equal(removeIndexLine(md, "a.md"), md);
});

test("deleteMemory removes the file and its index line", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "da", body: "ba", title: "A", hook: "ha" });
	writeMemory(dir, { name: "b", description: "db", body: "bb", title: "B", hook: "hb" });

	assert.equal(deleteMemory(dir, "a"), true);
	assert.equal(fs.existsSync(path.join(dir, "a.md")), false);
	assert.equal(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8"), "- [B](b.md) — hb\n");
	assert.deepEqual(listMemories(dir).map((m) => m.name), ["b"]);
});

test("deleteMemory removes MEMORY.md when the index empties", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "d", body: "b" });

	assert.equal(deleteMemory(dir, "a"), true);
	assert.equal(fs.existsSync(path.join(dir, "MEMORY.md")), false);
	assert.deepEqual(listMemories(dir), []);
	assert.equal(buildMemoryPrompt(dir), null);
});

test("deleteMemory returns false for a missing memory and still cleans a stale index line", () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [A](a.md) — stale\n");

	assert.equal(deleteMemory(dir, "a"), false);
	assert.equal(fs.existsSync(path.join(dir, "MEMORY.md")), false);
});

test("deleteMemory rejects a name that escapes the memory directory", () => {
	const dir = tmpdir();
	assert.throws(() => deleteMemory(dir, "../escape"), /name/i);
	assert.throws(() => deleteMemory(dir, "a/b"), /name/i);
});

test("a deleted memory name can be written again", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "first", body: "one" });
	deleteMemory(dir, "a");

	const out = writeMemory(dir, { name: "a", description: "second", body: "two" });
	assert.equal(out.created, true);
	assert.match(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8"), /\(a\.md\)/);
	assert.equal(readMemory(dir, "a")?.body, "two");
});

test("writeMemory output is still correct after deleteMemory of a sibling", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "da", body: "ba" });
	writeMemory(dir, { name: "b", description: "db", body: "bb" });
	deleteMemory(dir, "a");

	const index = parseIndex(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8"));
	assert.deepEqual(index.map((e) => e.file), ["b.md"]);

	// Writing again after a delete appends, not duplicates.
	writeMemory(dir, { name: "a", description: "da2", body: "ba2" });
	assert.equal(
		fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8").match(/\(a\.md\)/g)?.length,
		1,
	);
});

test("writeMemory output is readable by parseIndex and listMemories together", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "da", body: "ba", title: "A", hook: "ha" });
	writeMemory(dir, { name: "b", description: "db", body: "bb", title: "B", hook: "hb" });

	const index = parseIndex(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8"));
	assert.deepEqual(
		index.map((e) => e.file),
		["a.md", "b.md"],
	);
	assert.deepEqual(
		listMemories(dir).map((m) => m.description),
		["da", "db"],
	);
});

test("resolveWriteIntent reads an omitted body as a delete", () => {
	assert.deepEqual(resolveWriteIntent(undefined), { kind: "delete" });
});

test("resolveWriteIntent reads a JSON null body as a delete", () => {
	assert.deepEqual(resolveWriteIntent(null), { kind: "delete" });
});

test("resolveWriteIntent reads an empty body as a delete", () => {
	assert.deepEqual(resolveWriteIntent(""), { kind: "delete" });
});

test("resolveWriteIntent reads a whitespace-only body as a delete", () => {
	assert.deepEqual(resolveWriteIntent("   "), { kind: "delete" });
	assert.deepEqual(resolveWriteIntent("\t\n "), { kind: "delete" });
});

test("resolveWriteIntent reads the literal string null as a delete", () => {
	assert.deepEqual(resolveWriteIntent("null"), { kind: "delete" });
});

test("resolveWriteIntent ignores case and surrounding whitespace on the literal null", () => {
	assert.deepEqual(resolveWriteIntent(" null "), { kind: "delete" });
	assert.deepEqual(resolveWriteIntent("NULL"), { kind: "delete" });
	assert.deepEqual(resolveWriteIntent("Null"), { kind: "delete" });
});

test("resolveWriteIntent reads a body that merely mentions null as a write", () => {
	assert.deepEqual(resolveWriteIntent("null pointer dereference"), {
		kind: "update",
		body: "null pointer dereference",
	});
});

test("resolveWriteIntent trims the body of a write", () => {
	assert.deepEqual(resolveWriteIntent("  the fact  "), { kind: "update", body: "the fact" });
});

test("resolveWriteIntent rejects a body that is neither a string nor null", () => {
	assert.throws(() => resolveWriteIntent(42 as unknown as string), /Invalid body/);
});

test("applyMemoryWrite deletes when the body is the literal string null", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "da", body: "ba" });

	const outcome = applyMemoryWrite(dir, { name: "a", body: "null" });

	assert.equal(outcome.action, "deleted");
	assert.equal(outcome.action === "deleted" && outcome.existed, true);
	assert.equal(fs.existsSync(path.join(dir, "a.md")), false);
	assert.deepEqual(listMemories(dir), []);
});

test("applyMemoryWrite never reports a delete as a write", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "da", body: "ba" });

	// Every shape that carries no body takes the delete path, and the
	// outcome says so — the caller cannot mistake it for an update.
	for (const body of [undefined, null, "", "   ", "null", " null ", "NULL"]) {
		const outcome = applyMemoryWrite(dir, { name: "a", body });
		assert.equal(outcome.action, "deleted");
	}

	// The memory is gone, and nothing wrote a body of "null" in its place.
	assert.equal(fs.existsSync(path.join(dir, "a.md")), false);
	assert.equal(readMemory(dir, "a"), null);
});

test("applyMemoryWrite writes a body that merely mentions null", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "da", body: "ba" });

	const outcome = applyMemoryWrite(dir, { name: "a", body: "null pointer dereference" });

	assert.equal(outcome.action, "written");
	assert.equal(outcome.action === "written" && outcome.created, false);
	assert.equal(readMemory(dir, "a")?.body, "null pointer dereference");
});

test("applyMemoryWrite reports a delete of a memory that does not exist", () => {
	const dir = tmpdir();

	const outcome = applyMemoryWrite(dir, { name: "missing", body: "null" });

	assert.equal(outcome.action, "deleted");
	assert.equal(outcome.action === "deleted" && outcome.existed, false);
});

test("applyMemoryWrite keeps the previous description when the description is omitted", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "original", body: "one" });

	const outcome = applyMemoryWrite(dir, { name: "a", body: "two" });

	assert.equal(outcome.action, "written");
	assert.equal(readMemory(dir, "a")?.description, "original");
	assert.equal(readMemory(dir, "a")?.body, "two");
});
