import type { SpawnCallOptions, SpawnProgram, SpawnResult } from '@fuzdev/gro/spawn.ts';

/**
 * How a program ended and its output as UTF-8 text.
 */
export type SpawnCaptured = SpawnResult & { stdout: string; stderr: string };

const read_text = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
	const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
	let text = '';
	for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
	return text + decoder.decode();
};

/**
 * Runs `program`, capturing its stdout and stderr with stdin inherited. The inherited
 * stream keeps the child in the terminal's session, so unlike `SpawnProgram.out`,
 * `/dev/tty` still reaches ssh, a credential helper, or a pinentry. A process the program
 * leaves running that still holds a pipe is cut off after a bounded wait, unreported, so its
 * later output is lost.
 * @param args - the arguments after `argv[0]`
 * @throws `SpawnError` - if the program can't start
 */
export const spawn_capture = async (
	program: SpawnProgram,
	args: ReadonlyArray<string>,
	options?: SpawnCallOptions
): Promise<SpawnCaptured> => {
	const child = await program.start(args, { ...options, stdio: ['inherit', 'pipe', 'pipe'] });
	const [stdout, stderr, result] = await Promise.all([
		read_text(child.stdout!),
		read_text(child.stderr!),
		child.closed
	]);
	return { ...result, stdout, stderr };
};
