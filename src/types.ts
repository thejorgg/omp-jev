export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };
export type Entry = string | null | Json[] | { [key: string]: Json };
export type Question =
	| {
			type: "noul";
			instructions: Entry;
			criteria?: { true?: Entry; false?: Entry };
	  }
	| { type: "choice"; instructions: Entry; criteria: Record<string, Entry> }
	| { type: "score"; instructions: Entry; criteria: Entry[] };
export type Answer =
	| { type: "noul"; noul: number }
	| {
			type: "choice";
			choice: string;
			probabilities: Record<string, number>;
			confidence: number;
	  }
	| {
			type: "score";
			score: number;
			legend: Record<string, Entry>;
			probabilities: Record<string, number>;
			confidence: number;
	  };
export interface Evaluation {
	model: string;
	answers: Record<string, Answer>;
}
export interface ClientConfig {
	endpoint: string;
	model: string;
	apiKeyEnv: string;
	timeoutMs: number;
}
export type Gate = {
	choice?: string;
	minProbability?: number;
	minConfidence?: number;
	min?: number;
	max?: number;
};
export type RuleEvent =
	| "before_agent_start"
	| "tool_call"
	| "tool_result"
	| "session_stop"
	| "manual";
export type RuleAction = {
	type: "message" | "block" | "continue";
	message: string;
};
export interface Rule {
	id: string;
	enabled?: boolean;
	events: RuleEvent[];
	tools?: string[];
	question: Question;
	state?: Json;
	outcomes: { when: Gate; action: RuleAction }[];
	cooldownTurns?: number;
}
export interface RoutingPolicy {
	enabled: boolean;
	minConfidence: number;
	minProbability: number;
}
export interface JevConfig {
	version: 1;
	enabled: boolean;
	client: ClientConfig;
	context: {
		maxChars: number;
		recentMessages: number;
		includeSystemPrompt: boolean;
		redactKeys: string[];
	};
	thinking: RoutingPolicy;
	delegation: RoutingPolicy & { overrideExplicit: boolean };
	safety: RoutingPolicy & {
		tools: string[];
		onUncertain: "block" | "allow";
		onError: "block" | "allow";
	};
	nativeRules: RoutingPolicy;
	recovery: RoutingPolicy & { maxContinuations: number };
}
export interface RuleMatch {
	rule: Rule;
	answer: Answer;
	action: RuleAction;
}
export type Evaluate = (
	state: Json,
	questions: Record<string, Question>,
	signal?: AbortSignal,
) => Promise<Evaluation>;
