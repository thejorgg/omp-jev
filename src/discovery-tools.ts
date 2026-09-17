import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	type AstFindResult,
	FileType,
	type GlobResult,
	type GrepResult,
	astGrep,
	glob as nativeGlob,
	grep as nativeGrep,
} from "@oh-my-pi/pi-natives";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolSession,
} from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "./guards.js";
import type {
	DiscoveryAction,
	DiscoveryInventory,
	DiscoveryLocation,
	DiscoveryObservation,
	DiscoveryTools,
} from "./discovery.js";

// ---------------------------------------------------------------------------
// Bounds — every operation is bounded and abortable. Pagination is explicit:
// `nextSkip` is an absolute file offset (grep), `nextOffset` a 1-based line
// number (read).
// ---------------------------------------------------------------------------

const GREP_FILE_WINDOW = 20;
const GREP_MAX_MEMBERS = 200;
const GREP_NATIVE_MATCH_CAP = 2000;
const GREP_PER_FILE_CAP = 15;
const GREP_TIMEOUT_MS = 15_000;
const AST_MATCH_LIMIT = 100;
const AST_TIMEOUT_MS = 15_000;
const GLOB_LIMIT = 200;
const INVENTORY_MAX_FILES = 10_000;
const INVENTORY_TIMEOUT_MS = 20_000;
const READ_WINDOW_BYTES = 1024 * 1024;
const READ_DEFAULT_LINES = 200;
const READ_MAX_LINES = 1000;
const READ_LINE_MAX_CHARS = 4096;
const TEXT_MAX_LINES = 400;
const LINE_MAX_CHARS = 400;
const LOCATIONS_MAX = 300;
const SYMBOL_MAX_CHARS = 120;

/** LSP navigation operations that operate on a file target. */
const LSP_FILE_ACTIONS: Record<string, true> = {
	definition: true,
	references: true,
	implementation: true,
	type_definition: true,
	hover: true,
};

/** Non-dotfile secret stores that must never surface through implicit
 * discovery. Dotfiles (.env*, .git, .ssh, …) are already excluded because
 * every implicit scan runs with hidden files disabled. */
const SECRET_FILE_RE = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i;
const SECRET_KEY_BASE_RE = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i;

/** Minimal structural view of a built OMP tool; avoids the AgentTool generics. */
interface ToolCallResult {
	content?: ReadonlyArray<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

interface ExecutableTool {
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<ToolCallResult>;
}

/** Runtime-narrowed view of GlobTool details (tool output is untrusted). */
interface GlobDetailsView {
	files: string[];
	truncated: boolean;
	missingPaths: string[];
	error: string | undefined;
}

class DiscoveryToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DiscoveryToolError";
	}
}

class DiscoveryAbortError extends Error {
	constructor() {
		super("Discovery operation aborted");
		this.name = "AbortError";
	}
}

function fail(message: string): never {
	throw new DiscoveryToolError(message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DiscoveryAbortError();
}

/** Aborts must propagate as rejections, never become error text. */
function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted) return true;
	if (!(err instanceof Error)) return false;
	return err.name === "AbortError" || err.name === "ToolAbortError";
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function clipLine(line: string, max = LINE_MAX_CHARS): string {
	return clip(line.replace(/\r$/, ""), max);
}

function requireString(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		fail(`${what} is required`);
	return value;
}

function requireFiniteInt(value: unknown, what: string, min: number): number {
	const num = typeof value === "number" ? value : Number.NaN;
	if (!Number.isFinite(num)) fail(`${what} must be a finite number`);
	const floored = Math.floor(num);
	if (floored < min) fail(`${what} must be >= ${min}`);
	return floored;
}

/** Split a semicolon-delimited multi-path argument into members. */
function splitMembers(
	raw: string | undefined,
	what: string,
	max: number,
): string[] {
	if (raw === undefined || raw.trim().length === 0) return ["."];
	const members = raw
		.split(";")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (members.length === 0) fail(`${what} contains no paths`);
	if (members.length > max) fail(`${what} exceeds the maximum of ${max} paths`);
	return members;
}

function resultText(result: ToolCallResult): string {
	if (!Array.isArray(result.content)) return "";
	const parts: string[] = [];
	for (const part of result.content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string")
			parts.push(part.text);
	}
	return parts.join("\n");
}

/** Narrow untrusted GlobTool details; every field is individually type-checked. */
function viewGlobDetails(raw: unknown): GlobDetailsView {
	const view: GlobDetailsView = {
		files: [],
		truncated: false,
		missingPaths: [],
		error: undefined,
	};
	if (!isRecord(raw)) return view;
	if (Array.isArray(raw.files)) {
		for (const entry of raw.files)
			if (typeof entry === "string") view.files.push(entry);
	}
	if (raw.truncated === true) view.truncated = true;
	if (Array.isArray(raw.missingPaths)) {
		for (const entry of raw.missingPaths)
			if (typeof entry === "string") view.missingPaths.push(entry);
	}
	if (typeof raw.error === "string") view.error = raw.error;
	return view;
}

/**
 * Read-only, local-only discovery backend for the Jev dispatcher.
 *
 * Backed by the native scan/grep/AST engines from @oh-my-pi/pi-natives plus
 * OMP's own glob and LSP tools built from the public BUILTIN_TOOLS factories
 * with a minimal read-only ToolSession. File reads use a private bounded
 * numbered reader because the native read tool summarizes source files and
 * would hide the bodies discovery needs as evidence.
 */
export function createDiscoveryTools(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): DiscoveryTools {
	let cachedRoot: string | undefined;
	let cachedTools:
		| Promise<{ glob: ExecutableTool | null; lsp: ExecutableTool | null }>
		| undefined;

	const workspaceRoot = (): string => {
		if (cachedRoot !== undefined) return cachedRoot;
		try {
			cachedRoot = fs.realpathSync(ctx.cwd);
		} catch (err) {
			fail(`Workspace root is not accessible: ${ctx.cwd} (${messageOf(err)})`);
		}
		return cachedRoot;
	};

	/** Resolve a caller-supplied path to a real path confined to the workspace.
	 * Rejects URI schemes, missing targets, and any symlink chain that resolves
	 * outside the workspace root. */
	const confine = (raw: string, what: string): string => {
		const cleaned = raw.trim();
		if (cleaned.length === 0) fail(`${what}: empty path`);
		if (cleaned.includes("://"))
			fail(
				`${what} must be a local workspace path, not a URL: ${clip(cleaned, 200)}`,
			);
		const root = workspaceRoot();
		const abs = path.resolve(root, cleaned);
		let real: string;
		try {
			real = fs.realpathSync(abs);
		} catch {
			fail(`${what} not found: ${clip(cleaned, 200)}`);
		}
		const rel = path.relative(root, real);
		if (
			rel !== "" &&
			(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
		) {
			fail(`${what} escapes the workspace: ${clip(cleaned, 200)}`);
		}
		return real;
	};

	/** realpath containment check that returns null instead of failing. */
	const confinedQuiet = (root: string, abs: string): string | null => {
		let real: string;
		try {
			real = fs.realpathSync(abs);
		} catch {
			return null;
		}
		const rel = path.relative(root, real);
		if (
			rel === "" ||
			rel === ".." ||
			rel.startsWith(`..${path.sep}`) ||
			path.isAbsolute(rel)
		)
			return null;
		return real;
	};

	const isSecretName = (base: string): boolean =>
		SECRET_FILE_RE.test(base) || SECRET_KEY_BASE_RE.test(base);

	/** Files surfaced by implicit discovery and whose content may be returned:
	 * regular, not a symlink, not a secret store, and realpath-confined. */
	const isSafelyReadableScanFile = (root: string, abs: string): boolean => {
		try {
			const lst = fs.lstatSync(abs);
			if (lst.isSymbolicLink() || !lst.isFile()) return false;
			if (isSecretName(path.basename(abs))) return false;
		} catch {
			return false;
		}
		return confinedQuiet(root, abs) !== null;
	};

	const displayPath = (root: string, abs: string): string =>
		path.relative(root, abs) || ".";

	const buildSession = (): ToolSession => {
		const settings = pi.pi?.settings;
		if (!settings)
			fail(
				"pi.pi.settings is unavailable; cannot build the discovery tool session",
			);
		return {
			cwd: ctx.cwd,
			hasUI: false,
			settings,
			getSessionFile: () => ctx.sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
			enableLsp: true,
			lspReadOnly: true,
			hasEditTool: false,
		};
	};

	/** Built once per DiscoveryTools instance; never boots another agent. */
	const builtTools = (): Promise<{
		glob: ExecutableTool | null;
		lsp: ExecutableTool | null;
	}> => {
		if (!cachedTools) {
			cachedTools = (async () => {
				const factories = pi.pi?.BUILTIN_TOOLS;
				const session = buildSession();
				const globFactory = factories?.glob;
				const lspFactory = factories?.lsp;
				// Structural view of AgentTool<any, any>: execute() is all discovery needs.
				const glob =
					typeof globFactory === "function"
						? ((await globFactory(session)) as unknown as ExecutableTool | null)
						: null;
				const lsp =
					typeof lspFactory === "function"
						? ((await lspFactory(session)) as unknown as ExecutableTool | null)
						: null;
				return { glob, lsp };
			})();
			cachedTools.catch(() => {});
		}
		return cachedTools;
	};

	const observation = (
		text: string,
		locations: DiscoveryLocation[],
		extra: Partial<DiscoveryObservation> = {},
	): DiscoveryObservation => ({ text, locations, truncated: false, ...extra });

	const boundObservation = (
		lines: string[],
		locations: DiscoveryLocation[],
		extra: Partial<DiscoveryObservation> = {},
	): DiscoveryObservation => {
		if (lines.length > TEXT_MAX_LINES) {
			const dropped = lines.length - TEXT_MAX_LINES;
			const clipped = [
				...lines.slice(0, TEXT_MAX_LINES),
				`… ${dropped} more line(s) elided …`,
			];
			return observation(clipped.join("\n"), locations, {
				...extra,
				truncated: true,
			});
		}
		return observation(lines.join("\n"), locations, extra);
	};

	// -------------------------------------------------------------------------
	// read — own bounded numbered UTF-8 page (native read summaries hide bodies)
	// -------------------------------------------------------------------------

	const runRead = async (
		action: Extract<DiscoveryAction, { tool: "read" }>,
		signal?: AbortSignal,
	): Promise<DiscoveryObservation> => {
		throwIfAborted(signal);
		const root = workspaceRoot();
		const real = confine(requireString(action.path, "read path"), "read path");
		const stat = await fsp.stat(real);
		if (!stat.isFile())
			fail(`read target is not a regular file: ${action.path}`);
		const byteCap = Math.min(stat.size, READ_WINDOW_BYTES);
		let buffer = Buffer.allocUnsafe(byteCap);
		const handle = await fsp.open(
			real,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		try {
			throwIfAborted(signal);
			if (!(await handle.stat()).isFile())
				fail(`read target is not a regular file: ${action.path}`);
			const { bytesRead } = await handle.read(buffer, 0, byteCap, 0);
			buffer = buffer.subarray(0, bytesRead);
			throwIfAborted(signal);
		} finally {
			await handle.close();
		}
		if (buffer.subarray(0, Math.min(byteCap, 8192)).includes(0)) {
			fail(`read target looks binary; refusing to page: ${action.path}`);
		}
		let decoded = buffer.toString("utf-8");
		if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1);
		let lines = decoded.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		if (lines.length === 0) {
			return observation(`(empty file) ${displayPath(root, real)}`, []);
		}
		const offset = requireFiniteInt(action.offset ?? 1, "read offset", 1);
		const limit = Math.min(
			requireFiniteInt(action.limit ?? READ_DEFAULT_LINES, "read limit", 1),
			READ_MAX_LINES,
		);
		if (offset > lines.length) {
			fail(
				`read offset ${offset} is past end of file (${lines.length} lines): ${action.path}`,
			);
		}
		const page = lines.slice(offset - 1, offset - 1 + limit);
		const outLines = page.map(
			(line, idx) => `${offset + idx}|${clipLine(line, READ_LINE_MAX_CHARS)}`,
		);
		const nextOffset =
			offset - 1 + page.length < lines.length
				? offset + page.length
				: undefined;
		const extra: Partial<DiscoveryObservation> = {
			nextOffset,
			truncated: page.some((line) => line.length > READ_LINE_MAX_CHARS),
		};
		if (stat.size > READ_WINDOW_BYTES) {
			outLines.push(
				`… file truncated at the ${Math.floor(READ_WINDOW_BYTES / (1024 * 1024))} MiB read window (${stat.size} bytes total); lines beyond the window are missing …`,
			);
			extra.truncated = true;
		}
		return boundObservation(
			outLines,
			[{ path: displayPath(root, real), line: offset }],
			extra,
		);
	};

	// -------------------------------------------------------------------------
	// glob — OMP GlobTool (gitignore-aware native walker), post-filtered
	// -------------------------------------------------------------------------

	const runGlob = async (
		action: Extract<DiscoveryAction, { tool: "glob" }>,
		signal?: AbortSignal,
	): Promise<DiscoveryObservation> => {
		throwIfAborted(signal);
		const root = workspaceRoot();
		for (const member of splitMembers(
			action.path,
			"glob path",
			GREP_MAX_MEMBERS,
		)) {
			if (member.includes("://") || member.split(/[\\/]/).includes(".."))
				fail("glob requires local workspace paths without parent traversal");
			const wildcard = member.search(/[*?[\]{}]/);
			const prefix =
				wildcard < 0
					? member
					: member.slice(0, member.lastIndexOf("/", wildcard) + 1) || ".";
			confine(prefix, "glob path");
		}
		const { glob: globTool } = await builtTools();
		if (!globTool)
			fail("glob tool is unavailable (BUILTIN_TOOLS.glob missing)");
		let result: ToolCallResult;
		try {
			result = await globTool.execute(
				"jev-discovery",
				{
					path: action.path ?? ".",
					hidden: false,
					gitignore: true,
					limit: GLOB_LIMIT,
				},
				signal,
			);
		} catch (err) {
			if (isAbort(err, signal)) throw err;
			fail(`glob failed: ${messageOf(err)}`);
		}
		const text = resultText(result);
		const details = viewGlobDetails(result.details);
		if (result.isError === true || details.error !== undefined) {
			const message =
				text.trim().length > 0 ? text : (details.error ?? "glob failed");
			return observation(clip(message, 1000), [], {
				error: clip(message, 500),
			});
		}
		const outLines: string[] = [];
		const locations: DiscoveryLocation[] = [];
		let dropped = 0;
		for (const entry of details.files) {
			const clean = entry.replace(/\/$/, "");
			if (clean.split(/[\\/]/).includes("..") || path.isAbsolute(clean)) {
				dropped++;
				continue;
			}
			const abs = path.resolve(root, clean);
			let keep = false;
			try {
				const lst = fs.lstatSync(abs);
				keep =
					!lst.isSymbolicLink() &&
					lst.isFile() &&
					!isSecretName(path.basename(abs));
			} catch {
				keep = false;
			}
			if (keep) keep = confinedQuiet(root, abs) !== null;
			if (!keep) {
				dropped++;
				continue;
			}
			if (locations.length < LOCATIONS_MAX) locations.push({ path: clean });
			outLines.push(clean);
		}
		if (outLines.length === 0) outLines.push("No files found matching pattern");
		const extra: Partial<DiscoveryObservation> = {};
		if (details.truncated) {
			outLines.push(`… result list truncated at ${GLOB_LIMIT} entries …`);
			extra.truncated = true;
		}
		if (dropped > 0) {
			outLines.push(
				`… ${dropped} entr(y|ies) excluded (hidden, secret, symlinked, or outside the workspace) …`,
			);
			extra.truncated = true;
		}
		if (details.missingPaths.length > 0)
			outLines.push(
				`Skipped missing paths: ${details.missingPaths.join(", ")}`,
			);
		return boundObservation(outLines, locations, extra);
	};

	// -------------------------------------------------------------------------
	// grep — native structured matches (gitignore-aware, case-insensitive),
	// paginated by absolute file offset
	// -------------------------------------------------------------------------

	const runGrep = async (
		action: Extract<DiscoveryAction, { tool: "grep" }>,
		signal?: AbortSignal,
	): Promise<DiscoveryObservation> => {
		throwIfAborted(signal);
		const root = workspaceRoot();
		const pattern = requireString(action.pattern, "grep pattern");
		const members = splitMembers(action.path, "grep path", GREP_MAX_MEMBERS);
		const scopes: string[] = [];
		const missing: string[] = [];
		for (const member of members) {
			if (member.includes("://"))
				fail(
					`grep path must be a local workspace path, not a URL: ${clip(member, 200)}`,
				);
			let exists = true;
			try {
				fs.realpathSync(path.resolve(root, member));
			} catch {
				exists = false;
			}
			// Absent members only narrow scope (surfaced as a note); a member that
			// exists but resolves outside the workspace is a hard failure.
			if (!exists) missing.push(member);
			else scopes.push(confine(member, "grep path"));
		}
		interface ScopedMatch {
			abs: string;
			lineNumber: number;
			line: string;
		}
		const all: ScopedMatch[] = [];
		const fileOrder: string[] = [];
		const byFile = new Map<string, ScopedMatch[]>();
		let totalMatches = 0;
		let nativeLimitReached = false;
		for (const scope of scopes) {
			throwIfAborted(signal);
			let result: GrepResult;
			try {
				result = await nativeGrep({
					pattern,
					path: scope,
					ignoreCase: true,
					hidden: false,
					gitignore: true,
					maxCount: GREP_NATIVE_MATCH_CAP,
					maxCountPerFile: GREP_PER_FILE_CAP,
					maxColumns: LINE_MAX_CHARS,
					signal,
					timeoutMs: GREP_TIMEOUT_MS,
				});
			} catch (err) {
				if (isAbort(err, signal)) throw err;
				fail(
					`grep failed on ${clip(displayPath(root, scope), 200)}: ${messageOf(err)}`,
				);
			}
			totalMatches += result.totalMatches;
			nativeLimitReached = nativeLimitReached || result.limitReached === true;
			for (const match of result.matches) {
				const abs = path.isAbsolute(match.path)
					? match.path
					: path.resolve(scope, match.path);
				const scoped: ScopedMatch = {
					abs,
					lineNumber: match.lineNumber,
					line: match.line ?? "",
				};
				all.push(scoped);
				const list = byFile.get(abs);
				if (list) list.push(scoped);
				else {
					byFile.set(abs, [scoped]);
					fileOrder.push(abs);
				}
			}
		}
		const skip =
			action.skip === undefined
				? 0
				: requireFiniteInt(action.skip, "grep skip", 0);
		const hasMore = skip + GREP_FILE_WINDOW < fileOrder.length;
		const nextSkip = hasMore ? skip + GREP_FILE_WINDOW : undefined;
		const windowFiles = fileOrder.slice(skip, skip + GREP_FILE_WINDOW);

		const outLines: string[] = [
			`grep /${clip(pattern, 120)}/i — ${totalMatches} match(es) in ${fileOrder.length} file(s)`,
		];
		const locations: DiscoveryLocation[] = [];
		let droppedFiles = 0;
		let shownFiles = 0;
		for (const abs of windowFiles) {
			if (!isSafelyReadableScanFile(root, abs)) {
				droppedFiles++;
				continue;
			}
			const rel = displayPath(root, abs);
			outLines.push(rel);
			shownFiles++;
			for (const scoped of byFile.get(abs) ?? []) {
				if (scoped.lineNumber < 1) continue;
				const clipped = clipLine(scoped.line);
				outLines.push(`*${scoped.lineNumber}|${clipped}`);
				if (locations.length < LOCATIONS_MAX)
					locations.push({ path: rel, line: scoped.lineNumber, text: clipped });
			}
		}
		if (shownFiles === 0 && droppedFiles === 0)
			outLines.push("No matches found");
		const extra: Partial<DiscoveryObservation> = { nextSkip };
		if (hasMore)
			outLines.push(
				`… more files matched; use skip=${nextSkip} for the next page …`,
			);
		if (nativeLimitReached || totalMatches > all.length)
			outLines.push("… native match cap reached; results are partial …");
		if (droppedFiles > 0) {
			outLines.push(
				`… ${droppedFiles} file(s) in this page excluded (secret, symlinked, or outside the workspace) …`,
			);
		}
		if (missing.length > 0)
			outLines.push(`Skipped missing paths: ${missing.join(", ")}`);
		const truncated = Boolean(
			hasMore ||
				nativeLimitReached ||
				totalMatches > all.length ||
				droppedFiles > 0 ||
				missing.length > 0,
		);
		return boundObservation(outLines, locations, { ...extra, truncated });
	};

	// -------------------------------------------------------------------------
	// ast_grep — native structured AST matches, single confined scope
	// -------------------------------------------------------------------------

	const runAst = async (
		action: Extract<DiscoveryAction, { tool: "ast_grep" }>,
		signal?: AbortSignal,
	): Promise<DiscoveryObservation> => {
		throwIfAborted(signal);
		const root = workspaceRoot();
		const pattern = requireString(action.pattern, "ast_grep pattern");
		const scope = confine(
			requireString(action.path, "ast_grep path"),
			"ast_grep path",
		);
		let result: AstFindResult;
		try {
			result = await astGrep({
				patterns: [pattern],
				lang: action.lang,
				path: scope,
				offset: 0,
				limit: AST_MATCH_LIMIT + 1,
				includeMeta: false,
				signal,
				timeoutMs: AST_TIMEOUT_MS,
			});
		} catch (err) {
			if (isAbort(err, signal)) throw err;
			fail(`ast_grep failed: ${messageOf(err)}`);
		}
		const outLines: string[] = [
			`ast_grep ${clip(pattern, 120)} — ${result.totalMatches} match(es)`,
		];
		const locations: DiscoveryLocation[] = [];
		let dropped = 0;
		const matchRoot = fs.statSync(scope).isDirectory()
			? scope
			: path.dirname(scope);
		for (const match of result.matches.slice(0, AST_MATCH_LIMIT)) {
			const abs = path.isAbsolute(match.path)
				? match.path
				: path.resolve(matchRoot, match.path);
			if (!isSafelyReadableScanFile(root, abs)) {
				dropped++;
				continue;
			}
			if (match.startLine < 1) continue;
			const rel = displayPath(root, abs);
			const snippet = clipLine(match.text.split("\n")[0] ?? "");
			outLines.push(`${rel}:*${match.startLine}|${snippet}`);
			if (locations.length < LOCATIONS_MAX)
				locations.push({ path: rel, line: match.startLine, text: snippet });
		}
		if (locations.length === 0 && dropped === 0)
			outLines.push("No matches found");
		const extra: Partial<DiscoveryObservation> = {};
		if (
			result.matches.length > AST_MATCH_LIMIT ||
			result.totalMatches > result.matches.length ||
			result.limitReached === true
		) {
			outLines.push(
				`… match cap reached (${AST_MATCH_LIMIT} shown of ${result.totalMatches}); narrow the path or pattern …`,
			);
			extra.truncated = true;
		}
		if (dropped > 0) {
			outLines.push(
				`… ${dropped} match(es) excluded (secret, symlinked, or outside the workspace) …`,
			);
			extra.truncated = true;
		}
		if (result.parseErrors?.length) {
			outLines.push(
				`Parse issues (${result.parseErrors.length}); the query may be mis-scoped: ${clip(result.parseErrors.join("; "), 300)}`,
			);
			extra.truncated = true;
			if (!locations.length)
				extra.error = "AST parsing failed; absence is not established.";
		}
		return boundObservation(outLines, locations, extra);
	};

	// -------------------------------------------------------------------------
	// lsp — OMP LspTool in read-only mode; declared navigation operations only
	// -------------------------------------------------------------------------

	const toLocalLocation = (
		root: string,
		rawPath: string,
		line: number,
	): DiscoveryLocation | null => {
		const abs = path.isAbsolute(rawPath)
			? rawPath
			: path.resolve(root, rawPath);
		const real = confinedQuiet(root, abs);
		if (!real) return null;
		try {
			if (!fs.statSync(real).isFile()) return null;
		} catch {
			return null;
		}
		return {
			path: displayPath(root, real),
			line: line >= 1 ? line : undefined,
		};
	};

	const dedupeLocations = (
		locations: DiscoveryLocation[],
	): DiscoveryLocation[] => {
		const seen = new Set<string>();
		const unique: DiscoveryLocation[] = [];
		for (const location of locations) {
			const key = `${location.path}:${location.line ?? 0}:${location.symbol ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			unique.push(location);
			if (unique.length >= LOCATIONS_MAX) break;
		}
		return unique;
	};

	const parseLspLocations = (
		root: string,
		action: Extract<DiscoveryAction, { tool: "lsp" }>,
		text: string,
		queriedRel: string | undefined,
	): DiscoveryLocation[] => {
		if (action.action === "hover") {
			return queriedRel ? [{ path: queriedRel, line: action.line }] : [];
		}
		if (action.action === "symbols" && queriedRel) {
			const out: DiscoveryLocation[] = [];
			for (const line of text.split("\n")) {
				const match = /^(?:\s*)\S+ (.+) @ line (\d+)$/.exec(line);
				if (match)
					out.push({
						path: queriedRel,
						line: Number(match[2]),
						symbol: clip(match[1], SYMBOL_MAX_CHARS),
					});
			}
			if (out.length === 0) out.push({ path: queriedRel });
			return dedupeLocations(out);
		}
		const out: DiscoveryLocation[] = [];
		for (const line of text.split("\n")) {
			// Workspace symbol rows: "  <icon> <name> (container) @ <path>:<line>:<col>"
			const symbolMatch = /^ {2}\S+ (.+) @ (.+):(\d+):(\d+)$/.exec(line);
			if (symbolMatch) {
				const location = toLocalLocation(
					root,
					symbolMatch[2],
					Number(symbolMatch[3]),
				);
				if (location)
					out.push({
						...location,
						symbol: clip(symbolMatch[1], SYMBOL_MAX_CHARS),
					});
				continue;
			}
			// Navigation rows: "  <path>:<line>:<col>" (context lines are indented
			// four spaces, so exactly-two-space anchoring never matches them).
			const locationMatch = /^ {2}(\S.*):(\d+):(\d+)$/.exec(line);
			if (locationMatch) {
				const location = toLocalLocation(
					root,
					locationMatch[1],
					Number(locationMatch[2]),
				);
				if (location) out.push(location);
			}
		}
		return dedupeLocations(out);
	};

	const runLsp = async (
		action: Extract<DiscoveryAction, { tool: "lsp" }>,
		signal?: AbortSignal,
	): Promise<DiscoveryObservation> => {
		throwIfAborted(signal);
		const { lsp: lspTool } = await builtTools();
		if (!lspTool)
			fail(
				"LSP is unavailable (no language server integration or BUILTIN_TOOLS.lsp missing)",
			);
		if (
			action.action !== "symbols" &&
			!Object.hasOwn(LSP_FILE_ACTIONS, action.action)
		)
			fail("Unsupported read-only LSP action");
		const root = workspaceRoot();
		if (LSP_FILE_ACTIONS[action.action] === true && !action.file)
			fail(`lsp ${action.action} requires a file`);
		if (action.action === "symbols" && !action.file && !action.query?.trim())
			fail("lsp symbols requires a file or a query");
		const params: Record<string, unknown> = { action: action.action };
		let queriedRel: string | undefined;
		if (action.file === "*" && action.action === "symbols") params.file = "*";
		else if (action.file !== undefined) {
			const real = confine(action.file, "lsp file");
			let isFile = false;
			try {
				isFile = fs.statSync(real).isFile();
			} catch {
				isFile = false;
			}
			if (!isFile) fail(`lsp file is not a regular file: ${action.file}`);
			queriedRel = displayPath(root, real);
			params.file = real;
		}
		if (action.line !== undefined)
			params.line = requireFiniteInt(action.line, "lsp line", 1);
		if (action.symbol !== undefined) params.symbol = action.symbol;
		if (action.query !== undefined) params.query = action.query;
		let result: ToolCallResult;
		try {
			result = await lspTool.execute("jev-discovery", params, signal);
		} catch (err) {
			if (isAbort(err, signal)) throw err;
			fail(`lsp ${action.action} failed: ${messageOf(err)}`);
		}
		const text = resultText(result);
		const details = result.details;
		if (
			result.isError === true ||
			(isRecord(details) && details.success === false)
		) {
			const message =
				text.trim().length > 0 ? text : `lsp ${action.action} failed`;
			return observation(clip(message, 1000), [], {
				error: clip(message, 500),
			});
		}
		const locations = parseLspLocations(root, action, text, queriedRel);
		// Navigation text may include dependency sources outside the workspace.
		// Reconstruct evidence solely from validated local locations.
		if (action.action !== "hover") {
			const lines = locations.map(
				(location) =>
					`${location.path}${location.line ? `:${location.line}` : ""}${location.symbol ? ` ${location.symbol}` : ""}`,
			);
			return boundObservation(
				lines.length ? lines : ["No local symbols or locations found."],
				locations,
				{
					truncated:
						locations.length >= LOCATIONS_MAX ||
						/additional|truncat|limit reached/i.test(text),
				},
			);
		}
		return boundObservation(text.split("\n").map(clipLine), locations);
	};

	// -------------------------------------------------------------------------
	// dispatch
	// -------------------------------------------------------------------------

	const execute = async (
		action: DiscoveryAction,
		signal?: AbortSignal,
	): Promise<DiscoveryObservation> => {
		try {
			throwIfAborted(signal);
			if (!action || typeof action !== "object")
				fail("Invalid discovery action");
			switch (action.tool) {
				case "read":
					return await runRead(action, signal);
				case "glob":
					return await runGlob(action, signal);
				case "grep":
					return await runGrep(action, signal);
				case "ast_grep":
					return await runAst(action, signal);
				case "lsp":
					return await runLsp(action, signal);
				default:
					fail("Unsupported discovery action");
			}
		} catch (err) {
			if (isAbort(err, signal)) throw err;
			const toolName =
				typeof action === "object" && action !== null && "tool" in action
					? String(action.tool)
					: "unknown";
			if (err instanceof DiscoveryToolError) {
				return {
					text: "",
					locations: [],
					truncated: false,
					error: err.message,
				};
			}
			return {
				text: "",
				locations: [],
				truncated: false,
				error: `discovery ${toolName} failed: ${messageOf(err)}`,
			};
		}
	};

	const inventory = async (
		signal?: AbortSignal,
	): Promise<DiscoveryInventory> => {
		throwIfAborted(signal);
		const root = workspaceRoot();
		let result: GlobResult;
		try {
			result = await nativeGlob({
				pattern: "**/*",
				path: root,
				fileType: FileType.File,
				hidden: false,
				gitignore: true,
				recursive: true,
				maxResults: INVENTORY_MAX_FILES + 1,
				signal,
				timeoutMs: INVENTORY_TIMEOUT_MS,
			});
		} catch (err) {
			if (isAbort(err, signal)) throw err;
			fail(`inventory failed: ${messageOf(err)}`);
		}
		const files: string[] = [];
		let truncated = false;
		for (const entry of result.matches) {
			if (files.length >= INVENTORY_MAX_FILES) {
				truncated = true;
				break;
			}
			if (
				typeof entry.path !== "string" ||
				entry.path.split(/[\\/]/).includes("..") ||
				path.isAbsolute(entry.path)
			)
				continue;
			const abs = path.resolve(root, entry.path);
			try {
				const lst = fs.lstatSync(abs);
				if (lst.isSymbolicLink() || !lst.isFile()) continue;
			} catch {
				continue;
			}
			if (isSecretName(path.basename(abs))) continue;
			if (!confinedQuiet(root, abs)) continue;
			files.push(entry.path);
		}
		if (result.matches.length > INVENTORY_MAX_FILES) truncated = true;
		return { files, truncated };
	};

	return { inventory, execute };
}
