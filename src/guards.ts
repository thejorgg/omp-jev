import type { Json } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJson(value: unknown): value is Json {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	if (isRecord(value)) return Object.values(value).every(isJson);
	return false;
}
