/** Minimal Bun globals for files compiled only under the Bun runtime. */
declare const Bun: {
  spawn(
    args: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      terminal?: {
        cols: number;
        rows: number;
        name?: string;
        data?: (term: unknown, data: string | ArrayBuffer) => void;
      };
    },
  ): {
    pid: number;
    terminal?: { write(data: string): void; resize(cols: number, rows: number): void };
    kill(code?: number): void;
    exited: Promise<number>;
  };
};
