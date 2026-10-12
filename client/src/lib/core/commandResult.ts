// Mirrors command/runner.rs, serialized across the Tauri bridge.
export type CommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	truncated: boolean;
};
