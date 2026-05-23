<script lang="ts">
  import { apiBase } from '../lib/api.js';
  import { checkAuth } from '../lib/stores.js';
  import Icon from '../components/Icon.svelte';

  let password = $state('');
  let submitting = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    error = null;
    try {
      const res = await fetch(apiBase + 'auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.status === 429) {
        error = '尝试次数过多，请稍后再试';
      } else if (res.status === 401) {
        error = '密码错误';
      } else if (!res.ok) {
        error = `登录失败（${res.status}）`;
      } else {
        password = '';
        await checkAuth();
      }
    } catch (e) {
      error = `网络异常：${e}`;
    } finally {
      submitting = false;
    }
  }
</script>

<main>
  <form onsubmit={submit}>
    <div class="brand">
      <span class="logo"><Icon name="terminal" size={20} /></span>
      <div class="brand-text">
        <h1>oh-my-agent-shell</h1>
        <p class="subtitle">浏览器终端会话管理</p>
      </div>
    </div>

    <label class="field">
      <span class="label-text">密码</span>
      <input
        type="password"
        autocomplete="current-password"
        placeholder="请输入登录密码"
        bind:value={password}
        disabled={submitting}
        autofocus
      />
    </label>

    {#if error}
      <p class="error"><Icon name="alert" size={14} /> {error}</p>
    {/if}

    <button class="primary submit" type="submit" disabled={submitting || !password}>
      {#if submitting}
        <Icon name="refresh" size={14} />
        登录中…
      {:else}
        <Icon name="check" size={14} />
        登录
      {/if}
    </button>
  </form>
</main>

<style>
  main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: linear-gradient(180deg, #f7f8fa 0%, #eef1f6 100%);
  }
  form {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 32px;
    width: 360px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  .logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: var(--radius-sm);
  }
  .brand-text { flex: 1; }
  h1 { margin: 0; font-weight: 600; font-size: 17px; letter-spacing: -0.01em; }
  .subtitle { color: var(--fg-muted); margin: 2px 0 0; font-size: 12px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .label-text { font-size: 12px; color: var(--fg-muted); font-weight: 500; }
  .error {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid #f6c4ca;
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    margin: 0;
    font-size: 12px;
  }
  .submit { height: 38px; font-size: 14px; }
</style>
