/** Minimal Bun globals for files compiled only under the Bun runtime. */
declare const Bun: {
  /** Built-in password hashing (argon2id/bcrypt) — no native addon required. */
  password: {
    hash(
      password: string,
      algorithm?:
        | 'bcrypt'
        | 'argon2id'
        | 'argon2d'
        | 'argon2i'
        | { algorithm: 'argon2id' | 'argon2d' | 'argon2i'; memoryCost?: number; timeCost?: number },
    ): Promise<string>;
    verify(password: string, hash: string): Promise<boolean>;
  };
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
