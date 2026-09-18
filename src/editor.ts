import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

export async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function saveDocument(
	path: string,
	text: string,
	expected: string | undefined,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		if ((await readOptional(path)) !== expected)
			throw new Error(
				"File changed while editing; refusing to overwrite it. Reopen the editor.",
			);
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

/** OMP's editor dialog owns terminal suspension and its native Ctrl+G VISUAL/EDITOR integration. */
export async function editDocument(
	ctx: ExtensionCommandContext,
	path: string,
	initial: unknown,
	validate: (value: unknown) => unknown,
	prepare?: (value: unknown) => unknown | Promise<unknown>,
): Promise<boolean> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI)
			ctx.ui.notify(`Edit ${path} externally, then run /jev reload.`, "info");
		else console.log(`Edit ${path} externally, then run /jev reload.`);
		return false;
	}
	const original = await readOptional(path);
	let text = original ?? `${JSON.stringify(initial, null, 2)}\n`;
	if (prepare) {
		try {
			text = `${JSON.stringify(await prepare(JSON.parse(text)), null, 2)}\n`;
		} catch {
			// Keep malformed documents editable so the user can repair them.
		}
	}
	while (true) {
		const edited = await ctx.ui.editor(
			`Jev: ${path} (Ctrl+G: $VISUAL/$EDITOR)`,
			text,
		);
		if (edited === undefined) return false;
		text = edited;
		try {
			validate(JSON.parse(text));
		} catch (error) {
			ctx.ui.notify(
				`Not saved: ${error instanceof Error ? error.message : "invalid JSON"}`,
				"error",
			);
			continue;
		}
		await saveDocument(path, text, original);
		return true;
	}
}
