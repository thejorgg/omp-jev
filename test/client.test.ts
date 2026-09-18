import { afterAll, describe, expect, test } from "bun:test";
import { evaluate, validateAnswer, validateQuestion } from "../src/client.js";
import type { Answer, ClientConfig, Json, Question } from "../src/types.js";

const keyEnv = `JEV_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
process.env[keyEnv] = "local-test-key";
afterAll(() => {
	delete process.env[keyEnv];
});

const NOUL: Question = { type: "noul", instructions: "Urgent?" };
const CHOICE: Question = {
	type: "choice",
	instructions: "Which team?",
	criteria: { billing: "Payments", technical: "Bugs" },
};
const SCORE: Question = {
	type: "score",
	instructions: "How angry?",
	criteria: ["Calm", "Frustrated", "Very angry"],
};

const config = (endpoint: string, timeoutMs = 2_000): ClientConfig => ({
	endpoint,
	model: "jev-latest",
	apiKeyEnv: keyEnv,
	timeoutMs,
});

function serve(handler: (req: Request) => Response | Promise<Response>) {
	let count = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			count += 1;
			return handler(req);
		},
	});
	return {
		endpoint: `http://127.0.0.1:${server.port}/v1/systemone`,
		requests: () => count,
		stop: () => server.stop(true),
	};
}

// Hangs the request server-side; only the client's own timeout can end it,
// so test latency equals the configured timeout and no wall-clock sleep is needed.
function hangForever(): Promise<Response> {
	return new Promise<Response>(() => {});
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected promise to reject");
}

describe("evaluate wire contract", () => {
	test("posts state/model/questions with bearer auth and returns validated answers", async () => {
		let auth = "";
		let contentType = "";
		let body: unknown;
		const s = serve(async (req) => {
			auth = req.headers.get("authorization") ?? "";
			contentType = req.headers.get("content-type") ?? "";
			body = await req.json();
			return Response.json({
				model: "jev-latest",
				answers: { urgent: { type: "noul", noul: 0.92 } },
				usage: { input_tokens: 312, output_tokens: 48 },
			});
		});
		try {
			const result = await evaluate(config(s.endpoint), "Help!", {
				urgent: NOUL,
			});
			expect(auth).toBe("Bearer local-test-key");
			expect(contentType).toContain("application/json");
			expect(body).toEqual({
				state: "Help!",
				model: "jev-latest",
				questions: { urgent: NOUL },
			});
			expect(result.model).toBe("jev-latest");
			expect(result.answers.urgent).toEqual({ type: "noul", noul: 0.92 });
		} finally {
			s.stop();
		}
	});

	test("batches every question into one request", async () => {
		const s = serve(() =>
			Response.json({
				model: "jev-latest",
				answers: {
					team: {
						type: "choice",
						choice: "technical",
						probabilities: { billing: 0.1, technical: 0.9 },
						confidence: 0.8,
					},
					mood: {
						type: "score",
						score: 1.6,
						legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
						probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
						confidence: 0.78,
					},
				},
			}),
		);
		try {
			const result = await evaluate(config(s.endpoint), "s", {
				team: CHOICE,
				mood: SCORE,
			});
			expect(s.requests()).toBe(1);
			expect(result.answers.team).toEqual({
				type: "choice",
				choice: "technical",
				probabilities: { billing: 0.1, technical: 0.9 },
				confidence: 0.8,
			});
			expect(result.answers.mood).toEqual({
				type: "score",
				score: 1.6,
				legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
				probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
				confidence: 0.78,
			});
		} finally {
			s.stop();
		}
	});
});

describe("response validation fails closed", () => {
	test("rejects a choice answer whose probabilities do not match the criteria keys", async () => {
		const s = serve(() =>
			Response.json({
				model: "m",
				answers: {
					team: {
						type: "choice",
						choice: "billing",
						probabilities: { billing: 0.5, sales: 0.5 },
						confidence: 0.5,
					},
				},
			}),
		);
		try {
			await expect(
				evaluate(config(s.endpoint), "s", { team: CHOICE }),
			).rejects.toThrow();
		} finally {
			s.stop();
		}
	});

	test("rejects a choice answer whose selection is not the most probable option", async () => {
		const s = serve(() =>
			Response.json({
				model: "m",
				answers: {
					team: {
						type: "choice",
						choice: "billing",
						probabilities: { billing: 0.2, technical: 0.8 },
						confidence: 0.5,
					},
				},
			}),
		);
		try {
			await expect(
				evaluate(config(s.endpoint), "s", { team: CHOICE }),
			).rejects.toThrow();
		} finally {
			s.stop();
		}
	});

	test("accepts probabilities at the sum tolerance boundary but rejects drift and out-of-range values", async () => {
		const respond = (probabilities: Record<string, number>) =>
			serve(() =>
				Response.json({
					model: "m",
					answers: {
						team: {
							type: "choice",
							choice: "technical",
							probabilities,
							confidence: 0.5,
						},
					},
				}),
			);
		const boundary = respond({ billing: 0, technical: 0.99 });
		try {
			const result = await evaluate(config(boundary.endpoint), "s", {
				team: CHOICE,
			});
			expect(result.answers.team).toEqual({
				type: "choice",
				choice: "technical",
				probabilities: { billing: 0, technical: 0.99 },
				confidence: 0.5,
			});
		} finally {
			boundary.stop();
		}
		const drifted = respond({ billing: 0, technical: 0.989 });
		try {
			await expect(
				evaluate(config(drifted.endpoint), "s", { team: CHOICE }),
			).rejects.toThrow();
		} finally {
			drifted.stop();
		}
		const outOfRange = respond({ billing: 1.2, technical: -0.2 });
		try {
			await expect(
				evaluate(config(outOfRange.endpoint), "s", { team: CHOICE }),
			).rejects.toThrow();
		} finally {
			outOfRange.stop();
		}
	});

	test("rejects a noul answer carrying confidence or an out-of-range noul", async () => {
		const s = serve(() =>
			Response.json({
				model: "m",
				answers: { urgent: { type: "noul", noul: 0.5, confidence: 0.9 } },
			}),
		);
		try {
			await expect(
				evaluate(config(s.endpoint), "s", { urgent: NOUL }),
			).rejects.toThrow();
		} finally {
			s.stop();
		}
	});

	test("rejects missing answers and unexpected answer ids", async () => {
		const missing = serve(() => Response.json({ model: "m", answers: {} }));
		try {
			await expect(
				evaluate(config(missing.endpoint), "s", { team: CHOICE }),
			).rejects.toThrow();
		} finally {
			missing.stop();
		}
		const extra = serve(() =>
			Response.json({
				model: "m",
				answers: {
					team: {
						type: "choice",
						choice: "billing",
						probabilities: { billing: 0.6, technical: 0.4 },
						confidence: 0.2,
					},
					bonus: { type: "noul", noul: 1 },
				},
			}),
		);
		try {
			await expect(
				evaluate(config(extra.endpoint), "s", { team: CHOICE }),
			).rejects.toThrow();
		} finally {
			extra.stop();
		}
	});

	test("rejects non-2xx responses without echoing the body", async () => {
		const s = serve(() =>
			Response.json(
				{ error: { message: "boom SECRET-INTERNAL-DETAIL" } },
				{ status: 401 },
			),
		);
		try {
			const error = await rejectionOf(
				evaluate(config(s.endpoint), "s", { q: NOUL }),
			);
			expect(error.message).toContain("401");
			expect(error.message).not.toContain("SECRET-INTERNAL-DETAIL");
		} finally {
			s.stop();
		}
	});

	test("rejects malformed JSON bodies", async () => {
		const s = serve(
			() =>
				new Response('{"model":', {
					headers: { "content-type": "application/json" },
				}),
		);
		try {
			await expect(
				evaluate(config(s.endpoint), "s", { q: NOUL }),
			).rejects.toThrow();
		} finally {
			s.stop();
		}
	});
});

describe("timeouts, aborts, and redirects", () => {
	// AbortSignal.timeout is a native wall-clock timer not driven by the test
	// runner's clock, so these tests genuinely exercise real elapsed time.
	test("rejects with a timeout error when the server never responds", async () => {
		const s = serve(() => hangForever());
		try {
			await expect(
				evaluate(config(s.endpoint, 50), "s", { q: NOUL }),
			).rejects.toThrow();
		} finally {
			s.stop();
		}
	});

	test("timeout aborts stalled response body parsing", async () => {
		const s = serve(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"model":"m","ans'));
							// never closes
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		try {
			await expect(
				evaluate(config(s.endpoint, 50), "s", { q: NOUL }),
			).rejects.toThrow();
		} finally {
			s.stop();
		}
	});

	test("caller abort cancels an in-flight request", async () => {
		const s = serve(() => hangForever());
		const controller = new AbortController();
		try {
			const pending = evaluate(
				config(s.endpoint),
				"s",
				{ q: NOUL },
				controller.signal,
			);
			controller.abort();
			await expect(pending).rejects.toThrow();
		} finally {
			s.stop();
		}
	});

	test("refuses to follow redirects", async () => {
		const s = serve(
			() =>
				new Response(null, {
					status: 302,
					headers: { Location: "http://127.0.0.1:1/landing" },
				}),
		);
		try {
			await expect(
				evaluate(config(s.endpoint), "s", { q: NOUL }),
			).rejects.toThrow();
			expect(s.requests()).toBe(1);
		} finally {
			s.stop();
		}
	});
});

describe("endpoint and credential policy", () => {
	test("rejects http endpoints on non-loopback hosts", async () => {
		await expect(
			evaluate(config("http://api.typesafe.ai/v1/systemone"), "s", { q: NOUL }),
		).rejects.toThrow();
	});

	test("rejects endpoints embedding credentials", async () => {
		await expect(
			evaluate(config("https://user:pass@api.typesafe.ai/v1/systemone"), "s", {
				q: NOUL,
			}),
		).rejects.toThrow();
	});

	test("fails closed when the API key environment variable is unset", async () => {
		await expect(
			evaluate(
				{
					endpoint: "https://api.typesafe.ai/v1/systemone",
					model: "jev-latest",
					apiKeyEnv: "JEV_DEFINITELY_UNSET_KEY_ENV",
					timeoutMs: 1_000,
				},
				"s",
				{ q: NOUL },
			),
		).rejects.toThrow();
	});

	test("rejects non-JSON state before any request", async () => {
		const s = serve(() => Response.json({ model: "m", answers: {} }));
		try {
			await expect(
				evaluate(config(s.endpoint), { at: new Date() } as unknown as Json, {
					q: NOUL,
				}),
			).rejects.toThrow();
			expect(s.requests()).toBe(0);
		} finally {
			s.stop();
		}
	});

	test("rejects an empty questions map before any request", async () => {
		await expect(
			evaluate(config("https://api.typesafe.ai/v1/systemone"), "s", {}),
		).rejects.toThrow();
	});
});

describe("validateQuestion", () => {
	test("accepts structured Entry instructions and criteria", () => {
		const q: Question = {
			type: "score",
			instructions: { question: "Rate the tone", scale: ["low", "high"] },
			criteria: [{ level: "calm" }, null],
		};
		expect(validateQuestion(q)).toEqual(q);
	});

	test("rejects unknown fields, missing instructions, and non-Entry instructions", () => {
		expect(() =>
			validateQuestion({ type: "noul", instructions: "a", extra: 1 }),
		).toThrow();
		expect(() => validateQuestion({ type: "noul" })).toThrow();
		expect(() =>
			validateQuestion({ type: "noul", instructions: 42 }),
		).toThrow();
		expect(() =>
			validateQuestion({
				type: "noul",
				instructions: "a",
				criteria: { maybe: "x" },
			}),
		).toThrow();
		expect(() => validateQuestion(null)).toThrow();
	});

	test("requires at least 2 choice options and 2 score levels", () => {
		expect(() =>
			validateQuestion({
				type: "choice",
				instructions: "a",
				criteria: { only: "x" },
			}),
		).toThrow();
		expect(() =>
			validateQuestion({
				type: "score",
				instructions: "a",
				criteria: ["only"],
			}),
		).toThrow();
		expect(() =>
			validateQuestion({ type: "score", instructions: "a", criteria: "nope" }),
		).toThrow();
	});
});

describe("validateAnswer", () => {
	const validScore: Answer = {
		type: "score",
		score: 1.6,
		legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
		probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
		confidence: 0.78,
	};

	test("accepts a valid score answer", () => {
		expect(validateAnswer(SCORE, validScore)).toEqual(validScore);
	});

	test("rejects a score outside [0, levels-1]", () => {
		expect(() =>
			validateAnswer(SCORE, { ...validScore, score: 2.5 }),
		).toThrow();
		expect(() =>
			validateAnswer(SCORE, { ...validScore, score: -0.1 }),
		).toThrow();
	});

	test("rejects a legend that does not map every level", () => {
		expect(() =>
			validateAnswer(SCORE, {
				...validScore,
				legend: { "0": "Calm", "1": "Frustrated" },
			}),
		).toThrow();
	});

	test("rejects score probabilities that do not match the levels", () => {
		expect(() =>
			validateAnswer(SCORE, {
				...validScore,
				probabilities: { "0": 0.5, "1": 0.5 },
			}),
		).toThrow();
	});

	test("rejects an answer type that differs from the question", () => {
		expect(() => validateAnswer(SCORE, { type: "noul", noul: 0.5 })).toThrow();
	});

	test("noul stays a bare probability: no confidence, bounds inclusive", () => {
		expect(() =>
			validateAnswer(NOUL, { type: "noul", noul: 0.9, confidence: 0.9 }),
		).toThrow();
		expect(() => validateAnswer(NOUL, { type: "noul", noul: 1.5 })).toThrow();
		expect(validateAnswer(NOUL, { type: "noul", noul: 0 })).toEqual({
			type: "noul",
			noul: 0,
		});
		expect(validateAnswer(NOUL, { type: "noul", noul: 1 })).toEqual({
			type: "noul",
			noul: 1,
		});
	});
});
