<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type UserPublic, type UserRole } from '../lib/api.js';
  import { themePref, cycleTheme, THEME_LABEL } from '../lib/theme.js';
  import { navigate } from '../lib/router.js';
  import { currentUser } from '../lib/stores.js';
  import Icon from '../components/Icon.svelte';

  let users = $state<UserPublic[]>([]);
  let provisionable = $state(false);
  let isRoot = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  const me = $derived($currentUser);

  // New-user form.
  let username = $state('');
  let password = $state('');
  let role = $state<UserRole>('user');
  let osUser = $state('');
  let createOsUser = $state(false);
  let shell = $state('');
  let submitting = $state(false);

  async function load() {
    loading = true;
    try {
      const r = await api.listUsers();
      users = r.users;
      provisionable = r.provisionable;
      isRoot = r.isRoot;
    } catch (e) {
      error = humanError(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function reset() {
    username = '';
    password = '';
    role = 'user';
    osUser = '';
    createOsUser = false;
    shell = '';
  }

  async function addUser() {
    const u = username.trim();
    if (!u || password.length < 6) {
      error = '请填写用户名，密码至少 6 位。';
      return;
    }
    submitting = true;
    error = null;
    notice = null;
    try {
      await api.createUser({
        username: u,
        password,
        role,
        osUser: osUser.trim() || undefined,
        createOsUser: createOsUser || undefined,
        shell: createOsUser && shell.trim() ? shell.trim() : undefined,
      });
      reset();
      await load();
      notice = '已创建用户。';
    } catch (e) {
      error = humanError(e);
    } finally {
      submitting = false;
    }
  }

  async function changePassword(target: UserPublic) {
    const pw = prompt(`为「${target.username}」设置新密码（至少 6 位）：`);
    if (pw == null) return;
    if (pw.length < 6) {
      error = '密码至少 6 位。';
      return;
    }
    error = null;
    try {
      await api.updateUser(target.id, { password: pw });
      notice = `已更新「${target.username}」的密码。`;
    } catch (e) {
      error = humanError(e);
    }
  }

  async function toggleRole(target: UserPublic) {
    const next: UserRole = target.role === 'admin' ? 'user' : 'admin';
    error = null;
    try {
      await api.updateUser(target.id, { role: next });
      await load();
    } catch (e) {
      error = humanError(e);
    }
  }

  async function editOsUser(target: UserPublic) {
    const v = prompt(
      `将「${target.username}」映射到的 UNIX 用户名（留空清除映射）：`,
      target.osUser ?? '',
    );
    if (v == null) return;
    error = null;
    try {
      await api.updateUser(target.id, { osUser: v.trim() ? v.trim() : null });
      await load();
    } catch (e) {
      error = humanError(e);
    }
  }

  async function removeUser(target: UserPublic) {
    let purge = false;
    if (target.managed && target.osUser) {
      const r = confirm(
        `删除账号「${target.username}」。\n\n` +
          `该账号关联由 omas 创建的 UNIX 用户「${target.osUser}」。\n` +
          `点「确定」同时删除该 UNIX 用户及其主目录；点「取消」仅删除应用账号、保留 UNIX 用户。`,
      );
      purge = r;
    } else {
      if (!confirm(`删除账号「${target.username}」？该用户将无法再登录。`)) return;
    }
    error = null;
    try {
      const res = await api.deleteUser(target.id, purge);
      await load();
      if (purge && res.purged === true) notice = `已删除账号及 UNIX 用户「${target.osUser}」。`;
      else if (purge && res.purged === 'unsupported') notice = '已删除账号；当前环境无法删除 UNIX 用户（需 Linux + root）。';
      else notice = '已删除账号。';
    } catch (e) {
      error = humanError(e);
    }
  }

  function humanError(e: unknown): string {
    const str = String(e);
    const m = /:\s*(\{.*\})\s*$/.exec(str);
    if (m) {
      try {
        const body = JSON.parse(m[1]!);
        if (body.message) return body.message;
        if (body.error) return ERR_LABEL[body.error] ?? body.error;
      } catch {
        /* not json */
      }
    }
    if (str.includes('403')) return '需要管理员权限。';
    return `操作失败：${str}`;
  }

  const ERR_LABEL: Record<string, string> = {
    user_exists: '用户名已存在。',
    invalid_username: '用户名不合法（建议仅用小写字母、数字、下划线、连字符）。',
    os_user_not_found: '指定的 UNIX 用户不存在。',
    provision_unsupported: '仅 Linux 支持代建 UNIX 用户。',
    not_root: '代建 UNIX 用户需要服务以 root 运行。',
    last_admin: '不能移除/降级唯一的管理员。',
    forbidden: '需要管理员权限。',
  };
</script>

<div class="page">
  <header>
    <button class="ghost icon-only back" onclick={() => navigate({ name: 'list' })} aria-label="返回会话列表" title="返回会话列表">
      <Icon name="arrow-left" size={16} />
    </button>
    <span class="logo"><Icon name="users" size={18} /></span>
    <div class="brand-text">
      <div class="title">用户管理</div>
      <div class="subtitle">
        管理登录账号与角色{#if provisionable}，可代建 Linux UNIX 用户{/if}
        {#if !isRoot}<span class="hint">· 服务未以 root 运行，会话将以服务身份运行</span>{/if}
      </div>
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
  {#if notice}
    <p class="notice"><Icon name="check" size={14} /> {notice}</p>
  {/if}

  <section class="card form">
    <div class="form-head"><Icon name="user-plus" size={15} /> 新建用户</div>
    <div class="form-row">
      <label class="field">
        <span class="label">用户名</span>
        <input class="input" placeholder="如 alice" bind:value={username} disabled={submitting} />
      </label>
      <label class="field">
        <span class="label">密码（≥6 位）</span>
        <input class="input" type="password" placeholder="登录密码" bind:value={password} disabled={submitting} />
      </label>
      <label class="field narrow">
        <span class="label">角色</span>
        <select class="input" bind:value={role} disabled={submitting}>
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
      </label>
    </div>
    <div class="form-row">
      <label class="field grow">
        <span class="label">UNIX 用户{provisionable ? '（映射现有，或勾选代建）' : '（映射现有，可选）'}</span>
        <input
          class="input mono"
          placeholder={createOsUser ? '留空则与用户名相同' : '如 alice，可留空'}
          bind:value={osUser}
          disabled={submitting}
        />
      </label>
      {#if createOsUser}
        <label class="field grow">
          <span class="label">登录 shell（可选）</span>
          <input class="input mono" placeholder="如 /bin/bash" bind:value={shell} disabled={submitting} />
        </label>
      {/if}
    </div>
    <div class="form-actions">
      {#if provisionable}
        <label class="toggle">
          <input type="checkbox" bind:checked={createOsUser} disabled={submitting} />
          <span>代建 UNIX 用户（useradd）</span>
        </label>
      {:else}
        <span class="toggle-hint">代建 UNIX 用户仅在 Linux + root 下可用</span>
      {/if}
      <button class="primary" onclick={addUser} disabled={submitting}>
        {#if submitting}<Icon name="refresh" size={14} /> 创建中…{:else}<Icon name="plus" size={14} /> 创建{/if}
      </button>
    </div>
  </section>

  {#if loading}
    <p class="state">加载中…</p>
  {:else if users.length === 0}
    <div class="empty">
      <span class="empty-icon"><Icon name="users" size={28} /></span>
      <h3>暂无用户</h3>
      <p>在上方创建第一个账号。</p>
    </div>
  {:else}
    <ul class="list">
      {#each users as u (u.id)}
        <li class="row">
          <div class="row-main">
            <div class="row-head">
              <span class="uname">{u.username}</span>
              {#if u.role === 'admin'}<span class="tag tag-admin">管理员</span>{/if}
              {#if u.id === me?.id}<span class="tag tag-self">我</span>{/if}
            </div>
            <div class="row-sub mono">
              {#if u.osUser}
                <Icon name="terminal" size={12} /> {u.osUser}{#if u.managed}<span class="managed">· omas 创建</span>{/if}
              {:else}
                <span class="dim">未映射 UNIX 用户（以服务身份运行）</span>
              {/if}
            </div>
          </div>
          <div class="row-actions">
            <button class="ghost icon-only" title="修改密码" aria-label="修改密码" onclick={() => changePassword(u)}>
              <Icon name="key" size={15} />
            </button>
            <button class="ghost icon-only" title="映射 UNIX 用户" aria-label="映射 UNIX 用户" onclick={() => editOsUser(u)}>
              <Icon name="terminal" size={15} />
            </button>
            <button
              class="ghost icon-only"
              title={u.role === 'admin' ? '降为普通用户' : '设为管理员'}
              aria-label="切换角色"
              onclick={() => toggleRole(u)}
            >
              <Icon name="shield" size={15} />
            </button>
            <button class="ghost icon-only danger" title="删除账号" aria-label="删除账号" onclick={() => removeUser(u)}>
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
  .hint { color: var(--warning); }

  .error, .notice {
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
  .notice {
    color: var(--success);
    background: color-mix(in srgb, var(--success) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--success) 45%, transparent);
  }

  .card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .form { padding: 16px; margin-bottom: 20px; }
  .form-head { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 13.5px; margin-bottom: 14px; color: var(--fg); }
  .form-head > :global(svg) { color: var(--accent); }
  .form-row { display: flex; gap: 12px; margin-bottom: 12px; }
  .field { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex: 1; }
  .field.grow { flex: 1; }
  .field.narrow { flex: 0 0 130px; }
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
  .toggle { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--fg-muted); cursor: pointer; }
  .toggle input { cursor: pointer; }
  .toggle-hint { font-size: 12px; color: var(--fg-muted); }

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
  .uname { font-size: 14px; font-weight: 600; color: var(--fg); }
  .tag {
    border-radius: 999px; padding: 1px 8px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.02em;
  }
  .tag-admin { background: var(--accent-soft); color: var(--accent); }
  .tag-self { background: var(--bg-hover); color: var(--fg-muted); }
  .row-sub {
    display: flex; align-items: center; gap: 5px;
    font-size: 12px; color: var(--fg-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .managed { color: var(--accent); margin-left: 4px; }
  .dim { opacity: 0.8; font-family: var(--font, inherit); }
  .row-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
</style>
