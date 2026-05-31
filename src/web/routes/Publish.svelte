<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiBase, type PublicSite } from '../lib/api.js';
  import { themePref, cycleTheme, THEME_LABEL } from '../lib/theme.js';
  import { navigate } from '../lib/router.js';
  import Icon from '../components/Icon.svelte';

  let sites = $state<PublicSite[]>([]);
  let canPersist = $state(true);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let copiedSlug = $state<string | null>(null);

  // New-site form.
  let slug = $state('');
  let root = $state('');
  let spa = $state(false);
  let submitting = $state(false);

  function siteHref(s: string): string {
    const base = apiBase.replace(/api\/$/, '');
    return new URL(`p/${s}/`, new URL(base, location.href)).href;
  }

  async function load() {
    loading = true;
    try {
      const r = await api.listSites();
      sites = r.sites;
      canPersist = r.canPersist;
    } catch (e) {
      error = `加载失败：${e}`;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function addSite() {
    const s = slug.trim();
    const r = root.trim();
    if (!s || !r) {
      error = '请填写 slug 与目录路径。';
      return;
    }
    submitting = true;
    error = null;
    try {
      await api.createSite({ slug: s, root: r, spa });
      slug = '';
      root = '';
      spa = false;
      await load();
    } catch (e) {
      error = humanError(e);
    } finally {
      submitting = false;
    }
  }

  async function removeSite(s: string) {
    if (!confirm(`取消发布站点「${s}」？（仅停止公开访问，不删除目录文件）`)) return;
    error = null;
    try {
      await api.deleteSite(s);
      await load();
    } catch (e) {
      error = humanError(e);
    }
  }

  async function copyLink(s: string) {
    try {
      await navigator.clipboard.writeText(siteHref(s));
      copiedSlug = s;
      setTimeout(() => { if (copiedSlug === s) copiedSlug = null; }, 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  /** Surface the server's message field from a thrown request error if present. */
  function humanError(e: unknown): string {
    const str = String(e);
    const m = /:\s*(\{.*\})\s*$/.exec(str);
    if (m) {
      try {
        const body = JSON.parse(m[1]!);
        if (body.message) return body.message;
        if (body.error) return body.error;
      } catch {
        /* not json */
      }
    }
    return `操作失败：${str}`;
  }
</script>

<div class="page">
  <header>
    <button class="ghost icon-only back" onclick={() => navigate({ name: 'list' })} aria-label="返回会话列表" title="返回会话列表">
      <Icon name="arrow-left" size={16} />
    </button>
    <span class="logo"><Icon name="globe" size={18} /></span>
    <div class="brand-text">
      <div class="title">发布公开站点</div>
      <div class="subtitle">把目录挂到 /p/&lt;slug&gt;/，免密访问、便于分享</div>
    </div>
    <button
      class="ghost icon-only"
      title={`主题：${THEME_LABEL[$themePref]}（点击切换）`}
      aria-label="切换主题"
      onclick={cycleTheme}
    >
      {#if $themePref === 'light'}
        <Icon name="sun" size={16} />
      {:else if $themePref === 'dark'}
        <Icon name="moon" size={16} />
      {:else}
        <Icon name="monitor" size={16} />
      {/if}
    </button>
  </header>

  {#if error}
    <p class="error"><Icon name="alert" size={14} /> {error}</p>
  {/if}

  {#if !loading && !canPersist}
    <p class="warn">
      <Icon name="alert" size={14} />
      当前为内存配置或临时密码模式（--password / --password-file / OMAS_PASSWORD），无法保存到磁盘。
      请先运行 <code>omas init</code> 创建配置文件，或改用命令行 <code>--publish</code>。
    </p>
  {/if}

  <section class="card form" class:disabled={!canPersist}>
    <div class="form-row">
      <label class="field">
        <span class="label">slug（URL 名称）</span>
        <input
          class="input"
          placeholder="如 report"
          bind:value={slug}
          disabled={!canPersist || submitting}
          onkeydown={(e) => { if (e.key === 'Enter') addSite(); }}
        />
      </label>
      <label class="field grow">
        <span class="label">目录绝对路径</span>
        <input
          class="input mono"
          placeholder="如 /home/me/app/dist"
          bind:value={root}
          disabled={!canPersist || submitting}
          onkeydown={(e) => { if (e.key === 'Enter') addSite(); }}
        />
      </label>
    </div>
    <div class="form-actions">
      <label class="spa-toggle">
        <input type="checkbox" bind:checked={spa} disabled={!canPersist || submitting} />
        <span>SPA 回退（找不到文件时返回 index.html）</span>
      </label>
      <button class="primary" onclick={addSite} disabled={!canPersist || submitting}>
        {#if submitting}<Icon name="refresh" size={14} /> 发布中…{:else}<Icon name="plus" size={14} /> 发布{/if}
      </button>
    </div>
  </section>

  {#if loading}
    <p class="state">加载中…</p>
  {:else if sites.length === 0}
    <div class="empty">
      <span class="empty-icon"><Icon name="globe" size={28} /></span>
      <h3>暂无公开站点</h3>
      <p>在上方填写 slug 和目录路径即可发布第一个站点。</p>
    </div>
  {:else}
    <ul class="list">
      {#each sites as site (site.slug)}
        <li class="row">
          <div class="row-main">
            <div class="row-head">
              <a class="slug" href={siteHref(site.slug)} target="_blank" rel="noopener">/p/{site.slug}/</a>
              {#if site.spa}<span class="tag">SPA</span>{/if}
              {#if site.cli}<span class="tag tag-cli" title="由命令行 --publish 提供，此处不可修改">命令行</span>{/if}
            </div>
            <div class="root mono" title={site.root}>{site.root}</div>
          </div>
          <div class="row-actions">
            <button class="ghost icon-only" title="复制公开链接" aria-label="复制公开链接" onclick={() => copyLink(site.slug)}>
              {#if copiedSlug === site.slug}<Icon name="check" size={15} />{:else}<Icon name="copy" size={15} />{/if}
            </button>
            <a class="ghost icon-only open" href={siteHref(site.slug)} target="_blank" rel="noopener" title="在新标签页打开" aria-label="在新标签页打开">
              <Icon name="arrow-up" size={15} />
            </a>
            <button
              class="ghost icon-only danger"
              title={site.cli ? '命令行发布的站点不能在此删除' : '取消发布'}
              aria-label="取消发布"
              disabled={site.cli || !canPersist}
              onclick={() => removeSite(site.slug)}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .page {
    flex: 1;
    padding: 32px 28px;
    max-width: 820px;
    margin: 0 auto;
    width: 100%;
    overflow-y: auto;
  }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .back { padding: 0; width: 32px; height: 32px; }
  .logo {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px;
    background: var(--accent-soft); color: var(--accent);
    border-radius: var(--radius-sm);
  }
  .brand-text { flex: 1; min-width: 0; }
  .title { font-weight: 600; font-size: 17px; letter-spacing: -0.01em; }
  .subtitle { color: var(--fg-muted); font-size: 12px; margin-top: 1px; }

  .error, .warn {
    display: flex; align-items: center; gap: 6px;
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    margin: 0 0 16px;
    font-size: 13px;
    line-height: 1.5;
  }
  .error {
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .warn {
    color: var(--warning);
    background: var(--warning-soft);
    border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  }
  .warn code {
    font-family: var(--mono, monospace);
    background: color-mix(in srgb, currentColor 12%, transparent);
    padding: 0 4px; border-radius: 4px;
  }

  .card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .form { padding: 16px; margin-bottom: 20px; }
  .form.disabled { opacity: 0.6; }
  .form-row { display: flex; gap: 12px; margin-bottom: 12px; }
  .field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .field.grow { flex: 1; }
  .label { font-size: 12px; font-weight: 600; color: var(--fg-muted); }
  .input {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    font-size: 13px;
    width: 100%;
    box-sizing: border-box;
  }
  .input:focus { outline: none; border-color: var(--accent); }
  .mono { font-family: var(--mono, monospace); }
  .form-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .spa-toggle { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--fg-muted); cursor: pointer; }
  .spa-toggle input { cursor: pointer; }

  .state { color: var(--fg-muted); font-size: 13px; }
  .empty {
    display: flex; flex-direction: column; align-items: center; text-align: center;
    padding: 56px 24px; color: var(--fg-muted);
  }
  .empty-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 60px; height: 60px; margin-bottom: 16px;
    background: var(--bg-hover); border-radius: 50%;
  }
  .empty h3 { margin: 0 0 6px; color: var(--fg); font-weight: 600; font-size: 15px; }
  .empty p { margin: 0; font-size: 13px; }

  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .row {
    display: flex; align-items: center; gap: 10px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
  }
  .row:hover { border-color: var(--border-strong); }
  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .row-head { display: flex; align-items: center; gap: 8px; }
  .slug { font-family: var(--mono, monospace); font-size: 14px; font-weight: 600; color: var(--accent); text-decoration: none; }
  .slug:hover { text-decoration: underline; }
  .tag {
    background: var(--accent-soft); color: var(--accent);
    border-radius: 999px; padding: 1px 8px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.02em;
  }
  .tag-cli { background: var(--bg-hover); color: var(--fg-muted); }
  .root {
    font-size: 12px; color: var(--fg-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .open {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px;
    border: 1px solid transparent; border-radius: var(--radius-sm);
    text-decoration: none; color: var(--fg-muted);
  }
  .open:hover { background: var(--bg-hover); color: var(--fg); border-color: var(--border-strong); }
</style>
