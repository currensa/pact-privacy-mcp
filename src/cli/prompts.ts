import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

export interface Prompter {
  text(message: string, defaultValue?: string): Promise<string>;
  secret(message: string): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
}

class MutedOutput extends Writable {
  muted = false;

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) process.stderr.write(chunk, encoding);
    callback();
  }
}

export class TerminalPrompter implements Prompter {
  private requireTty(): void {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error("Interactive onboarding requires a TTY");
    }
  }

  async text(message: string, defaultValue?: string): Promise<string> {
    this.requireTty();
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(`${message}${suffix}: `)).trim();
      return answer || defaultValue || "";
    } finally {
      rl.close();
    }
  }

  async secret(message: string): Promise<string> {
    this.requireTty();
    const output = new MutedOutput();
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    process.stderr.write(`${message}: `);
    output.muted = true;
    try {
      return (await rl.question("")).trim();
    } finally {
      output.muted = false;
      rl.close();
      process.stderr.write("\n");
    }
  }

  async confirm(message: string, defaultValue = false): Promise<boolean> {
    const marker = defaultValue ? "Y/n" : "y/N";
    const value = (await this.text(`${message} (${marker})`)).toLowerCase();
    if (!value) return defaultValue;
    return value === "y" || value === "yes";
  }
}
