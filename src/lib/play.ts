import { AddisClip } from "./clip.js";

/**
 * Play audio through the system audio device (Node only). Lazily spawns
 * `ffplay` (from ffmpeg); falls back to `mpv`. Intended for local scripts and
 * demos, not production servers.
 */
export async function play(audio: AddisClip | ArrayBuffer | Uint8Array): Promise<void> {
  const bytes = audio instanceof AddisClip
    ? new Uint8Array(await audio.arrayBuffer())
    : audio instanceof ArrayBuffer
      ? new Uint8Array(audio)
      : audio;

  const { spawn } = await import("node:child_process");

  const tryPlayer = (command: string, args: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      } catch {
        return resolve(false);
      }
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin?.on("error", () => {});
      child.stdin?.write(Buffer.from(bytes));
      child.stdin?.end();
    });

  if (await tryPlayer("ffplay", ["-autoexit", "-nodisp", "-loglevel", "quiet", "-"])) return;
  if (await tryPlayer("mpv", ["--really-quiet", "-"])) return;
  throw new Error(
    "play() requires ffplay (ffmpeg) or mpv on PATH. Save the clip with clip.toFile() instead.",
  );
}
