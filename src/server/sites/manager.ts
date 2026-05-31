import fs from 'node:fs';
import path from 'node:path';
import { saveConfig, type Config } from '../config.js';
import { logger } from '../logger.js';
import { isValidSlug, mergeSiteSpecs, type SiteSpec } from './util.js';

export type ResolvedSite = SiteSpec & { root: string };

/** Typed error so route handlers can map a failure to an HTTP status + code. */
export class SiteError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
    this.name = 'SiteError';
  }
}

/**
 * Resolve site roots to absolute paths and drop any that don't point at an
 * existing directory (with a warning). Returns only mountable sites.
 */
export function resolveSites(specs: SiteSpec[]): ResolvedSite[] {
  const out: ResolvedSite[] = [];
  for (const spec of specs) {
    const root = path.resolve(spec.root);
    try {
      if (!fs.statSync(root).isDirectory()) {
        logger.warn({ slug: spec.slug, root }, 'publish: not a directory — skipping');
        continue;
      }
    } catch {
      logger.warn({ slug: spec.slug, root }, 'publish: directory not found — skipping');
      continue;
    }
    out.push({ ...spec, root });
  }
  return out;
}

/**
 * Owns the set of live public sites and keeps it in sync with config.json.
 *
 * Sites come from two places: persistent entries in `config.json` (editable via
 * the API/UI) and ephemeral `--publish` CLI flags (operator-only, not editable
 * here). The route handlers read the live registry on every request, so adding
 * or removing a site through the API takes effect without a server restart.
 *
 * `canPersist` is false when the running config is memory-only with a password
 * (`--password` / `--password-file` / `OMAS_PASSWORD`): writing it to disk would
 * break the "password never persisted" contract, so mutations are refused.
 */
export class SiteManager {
  private registry = new Map<string, ResolvedSite>();
  private readonly cliSlugs: Set<string>;

  constructor(
    private readonly dir: string,
    private readonly cfg: Config,
    private readonly cliSpecs: SiteSpec[],
    readonly canPersist: boolean,
  ) {
    this.cliSlugs = new Set(cliSpecs.map((s) => s.slug));
    this.recompute();
  }

  get(slug: string): ResolvedSite | undefined {
    return this.registry.get(slug);
  }

  list(): ResolvedSite[] {
    return [...this.registry.values()];
  }

  /** True when a slug is provided by a CLI flag (not editable via the API). */
  isCli(slug: string): boolean {
    return this.cliSlugs.has(slug);
  }

  private configSpecs(): SiteSpec[] {
    return (this.cfg.sites ?? []).map((s) => ({ slug: s.slug, root: s.root, spa: !!s.spa }));
  }

  private recompute(): void {
    const merged = mergeSiteSpecs(this.configSpecs(), this.cliSpecs);
    this.registry = new Map(resolveSites(merged).map((s) => [s.slug, s]));
  }

  /** Add or replace a persistent (config) site, then persist + reload. */
  addOrUpdate(input: { slug: string; root: string; spa: boolean }): ResolvedSite {
    this.assertPersistable();
    const slug = input.slug.trim();
    if (!isValidSlug(slug)) {
      throw new SiteError('invalid_slug', 400, 'slug 只允许字母数字与 . _ -，且不以符号开头');
    }
    if (this.isCli(slug)) {
      throw new SiteError('cli_managed', 409, `slug "${slug}" 由命令行 --publish 提供，不能在此修改`);
    }
    const rawRoot = input.root.trim();
    if (!rawRoot) throw new SiteError('invalid_root', 400, '目录不能为空');
    const root = path.resolve(rawRoot);
    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      throw new SiteError('root_not_found', 400, `目录不存在：${root}`);
    }
    if (!st.isDirectory()) throw new SiteError('root_not_dir', 400, `不是目录：${root}`);

    const next = this.configSpecs().filter((s) => s.slug !== slug);
    next.push({ slug, root, spa: input.spa });
    this.persist(next);
    return this.registry.get(slug)!;
  }

  /** Remove a persistent site. Returns false if the slug wasn't a config site. */
  remove(slug: string): boolean {
    this.assertPersistable();
    if (this.isCli(slug)) {
      throw new SiteError('cli_managed', 409, `slug "${slug}" 由命令行 --publish 提供，不能在此删除`);
    }
    const cur = this.configSpecs();
    if (!cur.some((s) => s.slug === slug)) return false;
    this.persist(cur.filter((s) => s.slug !== slug));
    return true;
  }

  private assertPersistable(): void {
    if (!this.canPersist) {
      throw new SiteError(
        'cannot_persist',
        409,
        '当前为内存配置或临时密码模式，无法保存到磁盘。请先运行 `omas init` 创建配置文件，或改用命令行 --publish。',
      );
    }
  }

  private persist(specs: SiteSpec[]): void {
    this.cfg.sites = specs.map((s) => ({ slug: s.slug, root: s.root, spa: s.spa }));
    saveConfig(this.dir, this.cfg);
    this.recompute();
    logger.info({ count: specs.length }, 'persisted public site config');
  }
}
