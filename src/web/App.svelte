<script lang="ts">
  import { onMount } from 'svelte';
  import { route, navigate } from './lib/router.js';
  import { auth, checkAuth } from './lib/stores.js';
  import { setTabTitle } from './lib/page-title.js';
  import List from './routes/List.svelte';
  import Login from './routes/Login.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import type { Component } from 'svelte';

  let TerminalRoute = $state<Component<{ sessionId: string }> | null>(null);
  let ShareRoute = $state<Component<{ token: string }> | null>(null);

  let current = $state($route);
  route.subscribe((r) => (current = r));

  let authState = $state($auth);
  auth.subscribe((a) => {
    authState = a;
    // The read-only share viewer is a public, capability-based page — never
    // bounce it through the login flow.
    if (current.name === 'shared') return;
    if (a === 'out' && current.name !== 'login') navigate({ name: 'login' });
    if (a === 'in' && current.name === 'login') navigate({ name: 'list' });
  });

  $effect(() => {
    if (current.name === 'shared' || current.name === 'terminal') return;
    if (authState === 'out' || current.name === 'login') {
      setTabTitle({ page: '登录' });
      return;
    }
    if (authState !== 'in') return;
    switch (current.name) {
      case 'list':
        setTabTitle({ page: '会话' });
        break;
      case 'history':
        setTabTitle({ page: '历史' });
        break;
      case 'publish':
        setTabTitle({ page: '站点' });
        break;
      case 'users':
        setTabTitle({ page: '用户' });
        break;
    }
  });

  let HistoryRoute = $state<Component | null>(null);
  let PublishRoute = $state<Component | null>(null);
  let UsersRoute = $state<Component | null>(null);

  onMount(() => {
    void checkAuth();
    void import('./routes/ShareView.svelte').then((m) => {
      ShareRoute = m.default;
    });
    void import('./routes/History.svelte').then((m) => {
      HistoryRoute = m.default;
    });
    void import('./routes/Terminal.svelte').then((m) => {
      TerminalRoute = m.default;
    });
    void import('./routes/Publish.svelte').then((m) => {
      PublishRoute = m.default;
    });
    void import('./routes/Users.svelte').then((m) => {
      UsersRoute = m.default;
    });
  });
</script>

{#if current.name === 'shared'}
  {#if ShareRoute}
    {#key current.token}
      <ShareRoute token={current.token} />
    {/key}
  {:else}
    <main class="boot">加载中…</main>
  {/if}
{:else if authState === 'unknown'}
  <main class="boot"></main>
{:else if authState === 'out'}
  <Login />
{:else if current.name === 'list'}
  <List />
{:else if current.name === 'terminal'}
  {#if TerminalRoute}
    {#key current.id}
      <TerminalRoute sessionId={current.id} />
    {/key}
  {:else}
    <main class="boot">加载中…</main>
  {/if}
{:else if current.name === 'history'}
  {#if HistoryRoute}
    <HistoryRoute />
  {:else}
    <main class="boot">加载中…</main>
  {/if}
{:else if current.name === 'publish'}
  {#if PublishRoute}
    <PublishRoute />
  {:else}
    <main class="boot">加载中…</main>
  {/if}
{:else if current.name === 'users'}
  {#if UsersRoute}
    <UsersRoute />
  {:else}
    <main class="boot">加载中…</main>
  {/if}
{:else if current.name === 'login'}
  <Login />
{/if}

{#if authState === 'in' && current.name !== 'shared'}
  <CommandPalette />
{/if}

<style>
  .boot {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-dim);
  }
</style>
