<script lang="ts">
  import { onMount } from 'svelte';
  import { route, navigate } from './lib/router.js';
  import { auth, checkAuth } from './lib/stores.js';
  import List from './routes/List.svelte';
  import Login from './routes/Login.svelte';
  import type { Component } from 'svelte';

  let TerminalRoute = $state<Component<{ sessionId: string }> | null>(null);

  let current = $state($route);
  route.subscribe((r) => (current = r));

  let authState = $state($auth);
  auth.subscribe((a) => {
    authState = a;
    if (a === 'out' && current.name !== 'login') navigate({ name: 'login' });
    if (a === 'in' && current.name === 'login') navigate({ name: 'list' });
  });

  let HistoryRoute = $state<Component | null>(null);

  onMount(() => {
    void checkAuth();
    void import('./routes/History.svelte').then((m) => {
      HistoryRoute = m.default;
    });
    void import('./routes/Terminal.svelte').then((m) => {
      TerminalRoute = m.default;
    });
  });
</script>

{#if authState === 'unknown'}
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
{:else if current.name === 'login'}
  <Login />
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
