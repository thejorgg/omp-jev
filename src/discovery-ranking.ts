/**
 * Language-agnostic term extraction and candidate ranking for discovery's
 * ranked grep mode (grep actions that carry a natural-language `query`).
 *
 * Pure functions only — no I/O and no native calls — so ranking decisions are
 * unit-testable and the discovery backend stays the only caller of the search
 * engines. Weighting follows measured real-repository discovery baselines:
 * per-term scans keep discriminative keywords from being crowded out by
 * common words, and file scores combine term coverage, inverse document
 * frequency, the strongest matching line, and path matches.
 */

/** Hard cap on extracted search terms per query. */
const MAX_SEARCH_TERMS = 12;

/** Request boilerplate: words that describe the *ask* rather than the
 * subject, measured on real-repository discovery baselines. Identifiers and
 * quoted phrases are never filtered against this set. */
const REQUEST_STOP_WORDS = new Set(
	(
		"a an all and are at be before by can code could do does edit file files " +
		"find for from how i in is it me of on or please read related repository " +
		"should show source that the these this to want we where which with would " +
		"app after into its when as up"
	).split(" "),
);

/** Longest quoted phrase kept verbatim; longer spans are noise, not intent. */
const MAX_PHRASE_CHARS = 200;

const TOKEN_RE = /[\p{L}\p{N}_$]+/gu;
const QUOTED_RE = /[`"']([^`"'\n]+)[`"']/g;

/** Modest suffix stripping for ordinary English words. A stem shorter than
 * three characters is discarded ("doing" stays "doing") because ultra-short
 * stems match everything and drown real signal. */
const stemWord = (word: string): string => {
	const stemmed = word.replace(/(?:ing|ed|es|s)$/, "");
	return stemmed.length >= 3 ? stemmed : word;
};

/** Identifiers — snake_case, camelCase, PascalCase, ALL CAPS, or anything
 * with a digit or `$` — are matched verbatim; stemming would break them. */
const looksLikeIdentifier = (token: string): boolean =>
	/[_$\d]/.test(token) ||
	/[a-z][A-Z]/.test(token) ||
	(token.length >= 2 && token === token.toUpperCase() && /\p{L}/u.test(token));

/**
 * Extract ranked-grep search terms from a natural-language description.
 * Quoted phrases are preserved verbatim first, then word tokens: identifiers
 * survive unstemmed, request boilerplate is dropped, and ordinary words get
 * modest suffix stemming. Terms are lowercase (searches run
 * case-insensitive) and capped at 12.
 */
export function searchTerms(description: string): string[] {
	if (typeof description !== "string") return [];
	const terms: string[] = [];
	const seen = new Set<string>();
	const push = (term: string): void => {
		const key = term.toLowerCase();
		if (key.length === 0 || seen.has(key)) return;
		seen.add(key);
		terms.push(key);
	};
	for (const match of description.matchAll(QUOTED_RE))
		push((match[1] ?? "").slice(0, MAX_PHRASE_CHARS));
	for (const token of description.match(TOKEN_RE) ?? []) {
		if (looksLikeIdentifier(token)) {
			push(token);
			continue;
		}
		const word = token.toLowerCase();
		if (word.length <= 2 || REQUEST_STOP_WORDS.has(word)) continue;
		push(word.length > 4 ? stemWord(word) : word);
	}
	return terms.slice(0, MAX_SEARCH_TERMS);
}

/**
 * Ranking key for semantic directory preferences: the first two directory
 * segments when available ("src/lib/util.ts" → "src/lib"), the first
 * directory otherwise ("src/util.ts" → "src"), "." for root files.
 */
export function directoryKey(filePath: string): string {
	const segments = filePath
		.split(/[\\/]+/)
		.filter((segment) => segment.length > 0 && segment !== ".");
	const directories = /[\\/]$/.test(filePath)
		? segments
		: segments.slice(0, -1);
	if (directories.length === 0) return ".";
	return directories.slice(0, 2).join("/");
}

// ---------------------------------------------------------------------------
// Candidate ranking
// ---------------------------------------------------------------------------

export interface RankedMatch {
	/** 1-indexed line number. */
	line: number;
	/** Matched line content (already column-capped by the native engine). */
	text: string;
}

export interface RankedFile {
	path: string;
	score: number;
	/** Query terms present in the path or its matched lines. */
	termsHit: number;
	/** Diverse top snippets, ascending by line. */
	matches: RankedMatch[];
}

const SNIPPETS_PER_FILE = 6;
/** Minimum line gap between score-picked snippets before backfilling. */
const SNIPPET_LINE_GAP = 3;

const DOC_FILE_RE = /\.(?:md|mdx|rst|txt|adoc)$/i;
const DOC_DIR_RE = /(?:^|\/)(?:docs?|design|art|assets)(?:\/|$)/i;
const DOC_QUERY_RE = /\b(?:documentation|docs?|readme|guides?)\b/i;
const LOW_PATH_RE =
	/(?:^|\/)(?:test|tests|__tests__|spec|fixtures|vendor|generated|dist|build)(?:\/|$)|(?:\.test|\.spec|\.min)\.|lock(?:\.json|\.yaml)?$|lockfile|legacy/i;
const LOW_QUERY_RE =
	/\b(?:tests?|specs?|fixtures?|legacy|generated|lockfiles?)\b/i;

/** Soft factors; none of them hard-exclude a language or a file kind. */
const DOC_REQUESTED_FACTOR = 1.4;
const DOC_UNREQUESTED_FACTOR = 0.15;
const SOURCE_WHEN_DOCS_REQUESTED_FACTOR = 0.3;
const LOW_UNREQUESTED_FACTOR = 0.3;
const PATH_SCORE_WEIGHT = 0.5;

/** priorities are relative directory weights, never scope permissions:
 * unlisted keys are neutral (1), finite values clamp to [0.1, 10] so no
 * entry can zero out or explode a file's score. */
const PRIORITY_FLOOR = 0.1;
const PRIORITY_CEILING = 10;

interface ScoredMatch extends RankedMatch {
	score: number;
}

function priorityFactor(
	filePath: string,
	priorities: Record<string, number> | undefined,
): number {
	if (!priorities) return 1;
	const raw = priorities[directoryKey(filePath)];
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
	return Math.min(PRIORITY_CEILING, Math.max(PRIORITY_FLOOR, raw));
}

/** Score-ordered picks with a minimum line gap, then backfill so files whose
 * evidence clusters on adjacent lines still expose six snippets. */
function selectDiverseSnippets(scored: ScoredMatch[]): ScoredMatch[] {
	const picked: ScoredMatch[] = [];
	const deferred: ScoredMatch[] = [];
	for (const item of scored) {
		if (picked.length >= SNIPPETS_PER_FILE) break;
		if (picked.some((p) => Math.abs(p.line - item.line) < SNIPPET_LINE_GAP))
			deferred.push(item);
		else picked.push(item);
	}
	for (const item of deferred) {
		if (picked.length >= SNIPPETS_PER_FILE) break;
		picked.push(item);
	}
	return picked;
}

/** Inverse document frequency: rare terms weigh more, ubiquitous terms
 * weigh barely above 1. */
function termWeights(
	candidates: Map<string, RankedMatch[]>,
	terms: string[],
): number[] {
	const frequencies = new Array<number>(terms.length).fill(0);
	for (const [filePath, matches] of candidates) {
		const hay =
			`${filePath}\n${matches.map((m) => m.text).join("\n")}`.toLowerCase();
		for (let i = 0; i < terms.length; i++)
			if (hay.includes(terms[i])) frequencies[i]++;
	}
	return frequencies.map(
		(count) => 1 + Math.log(1 + candidates.size / (1 + count)),
	);
}

/**
 * Rank candidate files for a natural-language query. Input is one entry per
 * unique file with its deduplicated match lines. Score combines term
 * coverage, inverse document frequency, the strongest matching line, and
 * path matches, scaled by soft factors for documentation and low-signal
 * paths (unless the query explicitly asks for them) and by the caller's
 * directory priorities. Output is score-descending; paging is the caller's
 * job.
 */
export function rankFiles(
	candidates: Map<string, RankedMatch[]>,
	terms: string[],
	query: string,
	priorities?: Record<string, number>,
): RankedFile[] {
	if (candidates.size === 0 || terms.length === 0) return [];
	const lowerTerms = terms.map((term) => term.toLowerCase());
	const weights = termWeights(candidates, lowerTerms);
	const lineScore = (text: string): number => {
		const lowered = text.toLowerCase();
		let score = 0;
		for (let i = 0; i < lowerTerms.length; i++)
			if (lowered.includes(lowerTerms[i])) score += weights[i];
		return score;
	};
	const docQuery = DOC_QUERY_RE.test(query);
	const lowQuery = LOW_QUERY_RE.test(query);
	const ranked: RankedFile[] = [];
	for (const [filePath, matches] of candidates) {
		const scored = matches
			.map((match) => ({ ...match, score: lineScore(match.text) }))
			.sort((a, b) => b.score - a.score);
		const best = selectDiverseSnippets(scored).sort((a, b) => a.line - b.line);
		const coverage = lineScore(
			`${filePath}\n${best.map((m) => m.text).join("\n")}`,
		);
		let score =
			coverage +
			(scored[0]?.score ?? 0) +
			lineScore(filePath) * PATH_SCORE_WEIGHT;
		const docPath = DOC_FILE_RE.test(filePath) || DOC_DIR_RE.test(filePath);
		score *= docPath
			? docQuery
				? DOC_REQUESTED_FACTOR
				: DOC_UNREQUESTED_FACTOR
			: docQuery
				? SOURCE_WHEN_DOCS_REQUESTED_FACTOR
				: 1;
		if (!lowQuery && LOW_PATH_RE.test(filePath))
			score *= LOW_UNREQUESTED_FACTOR;
		score *= priorityFactor(filePath, priorities);
		const combined =
			`${filePath}\n${matches.map((m) => m.text).join("\n")}`.toLowerCase();
		let termsHit = 0;
		for (const term of lowerTerms) if (combined.includes(term)) termsHit++;
		ranked.push({
			path: filePath,
			score,
			termsHit,
			matches: best.map(({ line, text }) => ({ line, text })),
		});
	}
	ranked.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
	return ranked;
}
