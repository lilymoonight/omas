<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api, type SystemStats } from '../lib/api.js';
  import Icon from './Icon.svelte';

  let stats = $state<SystemStats | null>(null);
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval>;

  async function refresh() {
    try {
      stats = await api.systemStats();
      error = null;
    } catch (e) {
      error = String(e);
    }
  }

  onMount(() => {
    refresh();
    timer = setInterval(refresh, 2000);
  });
  onDestroy(() => clearInterval(timer));

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    for (const u of units) {
      if (v < 1024) return `${v.toFixed(1)} ${u}`;
      v /= 1024;
    }
    return `${v.toFixed(1)} PB`;
  }
  function fmtUptime(s: number): string {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 时`;
    if (h > 0) return `${h} 时 ${m} 分`;
    return `${m} 分`;
  }
  function pct(used: number, total: number): number {
    return total > 0 ? (used / total) * 100 : 0;
  }
  function tone(p: number): 'ok' | 'warn' | 'crit' {
    if (p >= 90) return 'crit';
    if (p >= 70) return 'warn';
    return 'ok';
  }
</script>

<aside class="panel">
  <header>
    <span class="logo"><Icon name="activity" size={14} /></span>
    <span class="heading">系统负载</span>
  </header>

  {#if error}
    <p class="error"><Icon name="alert" size={13} /> 获取失败</p>
  {:else if !stats}
    <p class="loading">加载中…</p>
  {:else}
    <div class="meta">
      <span class="hostname" title={stats.hostname}>{stats.hostname}</span>
      <span class="platform" title={stats.platform}>{stats.platform}</span>
    </div>

    <section>
      <div class="row">
        <span class="row-label"><Icon name="cpu" size={13} /> CPU</span>
        <span class="row-value">{stats.cpu.percent.toFixed(0)}%</span>
      </div>
      <div class="bar tone-{tone(stats.cpu.percent)}">
        <span style="width: {Math.min(100, stats.cpu.percent)}%"></span>
      </div>
      <div class="row-sub">{stats.cpu.cores} 核 · 负载 {stats.load.map((n) => n.toFixed(2)).join(' / ')}</div>
    </section>

    <section>
      <div class="row">
        <span class="row-label"><Icon name="memory" size={13} /> 内存</span>
        <span class="row-value">{pct(stats.memory.used, stats.memory.total).toFixed(0)}%</span>
      </div>
      <div class="bar tone-{tone(pct(stats.memory.used, stats.memory.total))}">
        <span style="width: {pct(stats.memory.used, stats.memory.total)}%"></span>
      </div>
      <div class="row-sub">{fmtBytes(stats.memory.used)} / {fmtBytes(stats.memory.total)}</div>
    </section>

    {#if stats.disk}
      <section>
        <div class="row">
          <span class="row-label"><Icon name="hard-drive" size={13} /> 磁盘</span>
          <span class="row-value">{pct(stats.disk.used, stats.disk.total).toFixed(0)}%</span>
        </div>
        <div class="bar tone-{tone(pct(stats.disk.used, stats.disk.total))}">
          <span style="width: {pct(stats.disk.used, stats.disk.total)}%"></span>
        </div>
        <div class="row-sub" title={stats.disk.path}>
          {fmtBytes(stats.disk.used)} / {fmtBytes(stats.disk.total)}
        </div>
      </section>
    {/if}

    {#if stats.gpus && stats.gpus.length > 0}
      {@const model = stats.gpus[0].name.replace(/^NVIDIA\s+/i, '')}
      <section class="gpu-section">
        <div class="row">
          <span class="row-label"><Icon name="zap" size={13} /> GPU</span>
          <span class="row-value-thin">{stats.gpus.length} × {model.split(' ')[0]}</span>
        </div>
        {#each stats.gpus as g (g.index)}
          {@const memP = pct(g.memoryUsed, g.memoryTotal)}
          <div class="gpu">
            <div class="gpu-head">
              <span class="gpu-idx">#{g.index}</span>
              <span class="gpu-util">{g.utilization.toFixed(0)}%</span>
              <span class="gpu-temp" title="温度">{g.temperature.toFixed(0)}°</span>
            </div>
            <div class="bar bar-thin tone-{tone(g.utilization)}">
              <span style="width: {g.utilization}%"></span>
            </div>
            <div class="bar bar-thin bar-mem tone-{tone(memP)}">
              <span style="width: {memP}%"></span>
            </div>
            <div class="gpu-mem">{fmtBytes(g.memoryUsed)} / {fmtBytes(g.memoryTotal)}</div>
          </div>
        {/each}
      </section>
    {/if}

    <section class="uptime">
      <div class="row">
        <span class="row-label"><Icon name="clock" size={13} /> 系统运行</span>
        <span class="row-value-thin">{fmtUptime(stats.uptime)}</span>
      </div>
      <div class="row">
        <span class="row-label"><Icon name="terminal" size={13} /> 服务运行</span>
        <span class="row-value-thin">{fmtUptime(stats.processUptime)}</span>
      </div>
    </section>
  {/if}
</aside>

<style>
  .panel {
    width: 260px;
    flex-shrink: 0;
    background: var(--bg-elev);
    border-right: 1px solid var(--border);
    padding: 20px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-y: auto;
  }
  header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .logo {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px;
    background: var(--accent-soft); color: var(--accent);
    border-radius: var(--radius-sm);
  }
  .heading { font-weight: 600; font-size: 14px; }

  .meta {
    display: flex; flex-direction: column; gap: 2px;
    padding-bottom: 12px;
    border-bottom: 1px dashed var(--border);
  }
  .hostname { font-weight: 600; font-size: 13px; color: var(--fg); }
  .platform {
    font-size: 11px; color: var(--fg-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .loading, .error {
    color: var(--fg-muted); font-size: 12px; margin: 0;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .error { color: var(--danger); }

  section { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; justify-content: space-between; }
  .row-label {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--fg-muted); font-size: 12px; font-weight: 500;
  }
  .row-value { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 13px; }
  .row-value-thin { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--fg-muted); }
  .row-sub {
    font-size: 11px; color: var(--fg-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .bar {
    height: 6px; background: var(--bg-hover); border-radius: 3px; overflow: hidden;
  }
  .bar span {
    display: block; height: 100%;
    background: var(--accent);
    transition: width 200ms ease;
  }
  .bar.tone-warn span { background: #d4a72c; }
  .bar.tone-crit span { background: var(--danger); }

  .uptime { gap: 4px; }

  .gpu-section { gap: 8px; }
  .gpu {
    display: flex; flex-direction: column; gap: 3px;
    padding: 6px 8px;
    background: var(--bg-soft);
    border-radius: var(--radius-sm);
  }
  .gpu-head {
    display: flex; align-items: center; gap: 8px;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .gpu-idx {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-weight: 600; color: var(--fg-muted);
    min-width: 24px;
  }
  .gpu-util { flex: 1; font-weight: 600; color: var(--fg); }
  .gpu-temp { color: var(--fg-muted); }
  .gpu-mem {
    font-size: 10.5px; color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .bar-thin { height: 4px; }
  .bar-mem span { background: #8a96a3; }
  .bar-mem.tone-warn span { background: #d4a72c; }
  .bar-mem.tone-crit span { background: var(--danger); }
</style>
