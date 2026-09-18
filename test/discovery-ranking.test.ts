import { expect, test } from "bun:test";
import {
	directoryKey,
	rankFiles,
	searchTerms,
} from "../src/discovery-ranking.js";

// Pure term-extraction and ranking-key contracts shared with the dispatcher:
// boilerplate removal, identifier preservation, modest stemming, and the
// directory-key shape used for semantic priorities.

test("directoryKey keeps the first two directory segments", () => {
	expect(directoryKey("src/lib/util.ts")).toBe("src/lib");
	expect(directoryKey("src/util.ts")).toBe("src");
	expect(directoryKey("util.ts")).toBe(".");
	expect(directoryKey("./util.ts")).toBe(".");
	expect(directoryKey("src\\lib\\util.ts")).toBe("src/lib");
	expect(directoryKey("src/lib/")).toBe("src/lib");
});

test("searchTerms preserves identifiers and quoted phrases verbatim", () => {
	expect(searchTerms("fix getUserData_fromCache v2 renderState")).toEqual([
		"fix",
		"getuserdata_fromcache",
		"v2",
		"renderstate",
	]);
	// Quoted phrases survive even when they are pure boilerplate words.
	expect(searchTerms('show the "read" handling')).toEqual(["read", "handl"]);
	expect(searchTerms("API JSON doing things")).toEqual([
		"api",
		"json",
		"doing",
		"thing",
	]);
});

test("searchTerms yields nothing for pure boilerplate and caps at 12 terms", () => {
	expect(searchTerms("the of and to")).toEqual([]);
	expect(searchTerms("   ")).toEqual([]);
	expect(
		searchTerms(Array.from({ length: 30 }, (_, i) => `term${i}`).join(" ")),
	).toHaveLength(12);
});

test("a concentrated implementation outranks scattered terms despite a weak introductory match", () => {
	const candidates = new Map([
		[
			"a.ts",
			[
				{ line: 10, text: "purchase" },
				{ line: 30, text: "cancel" },
			],
		],
		[
			"b.ts",
			[
				{ line: 1, text: "purchase" },
				{ line: 100, text: "purchase cancel" },
			],
		],
	]);
	expect(
		rankFiles(candidates, ["purchase", "cancel"], "purchase cancel")[0].path,
	).toBe("b.ts");
});
